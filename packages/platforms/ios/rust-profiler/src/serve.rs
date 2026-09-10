//! `serve`: one long-lived process for a whole measure session. Requests are
//! NDJSON lines on stdin, responses NDJSON lines on stdout, interleaved with
//! the measure/status lines of the running poll. See README.md ("serve").
//!
//! The device connection (CoreDevice tunnel or lockdown) is opened on the
//! first request that needs it and reused afterwards; a failed operation
//! drops it, and the next request reconnects. Requests are handled strictly
//! one at a time: iOS closes concurrent dtservicehub connections.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tokio::io::{AsyncBufReadExt, BufReader, Lines, Stdin};
use tokio::sync::oneshot;

use crate::connect::Connection;
use crate::error;
use crate::measure::{emit, StatusLine};
use crate::ops::{self, OpError};
use crate::poll;

/// A request other than `stop`, `ping` or `devices` while a poll runs.
pub const BUSY: &str = "BUSY";

const DEFAULT_INTERVAL_MS: u32 = 500;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum Command {
    Ping,
    Devices,
    Info,
    Apps {
        #[serde(default)]
        raw: bool,
    },
    RunningApps,
    Launch {
        #[serde(rename = "bundleId")]
        bundle_id: String,
    },
    Kill {
        #[serde(rename = "bundleId")]
        bundle_id: Option<String>,
        pid: Option<u64>,
    },
    Poll {
        #[serde(rename = "bundleId")]
        bundle_id: String,
        #[serde(rename = "intervalMs")]
        interval_ms: Option<u32>,
        fps: Option<bool>,
    },
    Stop,
}

impl Command {
    /// Only these may run while a poll streams: everything else would need a
    /// second instruments connection, which the device refuses.
    pub fn allowed_while_polling(&self) -> bool {
        matches!(self, Command::Stop | Command::Ping | Command::Devices)
    }
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ResponseError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename = "response")]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Json>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

impl Response {
    pub fn ok(id: u64, result: Json) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: u64, code: &str, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(ResponseError {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }

    fn from_result(id: u64, result: Result<Json, OpError>) -> Self {
        match result {
            Ok(value) => Self::ok(id, value),
            Err(e) => Self::error(id, e.code, e.message),
        }
    }
}

/// One stdin line → the request, or the error response to send back. A line
/// without a usable numeric `id` is answered with id 0.
pub fn parse_request(line: &str) -> Result<Request, Response> {
    let value: Json = serde_json::from_str(line)
        .map_err(|e| Response::error(0, error::USAGE, format!("invalid JSON request: {e}")))?;
    let id = value.get("id").and_then(Json::as_u64).unwrap_or(0);
    serde_json::from_value::<Request>(value)
        .map_err(|e| Response::error(id, error::USAGE, format!("invalid request: {e}")))
}

struct State {
    udid: Option<String>,
    conn: Option<Connection>,
}

impl State {
    async fn connection(&mut self) -> Result<&mut Connection, OpError> {
        if self.conn.is_none() {
            self.conn = Some(ops::open_connection(self.udid.as_deref()).await?);
        }
        Ok(self.conn.as_mut().expect("connection just opened"))
    }

    async fn execute(&mut self, command: &Command) -> Result<Json, OpError> {
        let conn = self.connection().await?;
        match command {
            Command::Info => ops::info(conn).await,
            Command::Apps { raw } => ops::apps(conn, *raw).await,
            Command::RunningApps => ops::running_apps_json(conn).await,
            Command::Launch { bundle_id } => ops::launch(conn, bundle_id).await,
            Command::Kill { bundle_id, pid } => ops::kill(conn, *pid, bundle_id.as_deref()).await,
            Command::Ping | Command::Devices | Command::Stop | Command::Poll { .. } => {
                unreachable!("handled without a device connection")
            }
        }
    }

    /// Runs a command on the shared connection. A failure on a connection
    /// that was already open may just mean the tunnel died in between (the
    /// device was unplugged and replugged, the app listing service went
    /// away...): reconnect once and retry before giving up.
    async fn run(&mut self, command: &Command) -> Result<Json, OpError> {
        let was_open = self.conn.is_some();
        match self.execute(command).await {
            Ok(value) => Ok(value),
            Err(first) => {
                self.conn = None;
                if !was_open {
                    return Err(first);
                }
                error::warn(
                    error::SERVICE_FAILED,
                    format!("{} ({}), reconnecting once", first.message, first.code),
                );
                self.execute(command)
                    .await
                    .inspect_err(|_| self.conn = None)
            }
        }
    }
}

type Shutdown<'a> = Pin<&'a mut (dyn Future<Output = ()> + Send)>;

pub async fn serve(udid: Option<&str>) {
    let mut state = State {
        udid: udid.map(str::to_string),
        conn: None,
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut shutdown: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(poll::shutdown_signal());
    let mut signalled = false;

    loop {
        let line = tokio::select! {
            biased;
            _ = &mut shutdown, if !signalled => break,
            line = lines.next_line() => line,
        };
        // EOF (the parent went away) or an unreadable stdin: tear down
        let Ok(Some(line)) = line else { break };
        let request = match parse_request(&line) {
            Ok(request) => request,
            Err(response) => {
                emit(&response);
                continue;
            }
        };

        match request.command {
            Command::Ping => emit(&Response::ok(
                request.id,
                serde_json::json!({ "pong": true }),
            )),
            Command::Devices => emit(&Response::from_result(request.id, ops::devices().await)),
            Command::Stop => emit(&Response::ok(
                request.id,
                serde_json::json!({ "stopped": false }),
            )),
            Command::Poll {
                ref bundle_id,
                interval_ms,
                fps,
            } => {
                let bundle_id = bundle_id.clone();
                let interval_ms = interval_ms.unwrap_or(DEFAULT_INTERVAL_MS);
                let with_fps = fps.unwrap_or(true);
                let stdin_open = run_poll(
                    &mut state,
                    &mut lines,
                    shutdown.as_mut(),
                    &mut signalled,
                    request.id,
                    &bundle_id,
                    interval_ms,
                    with_fps,
                )
                .await;
                if !stdin_open || signalled {
                    break;
                }
            }
            ref command => emit(&Response::from_result(request.id, state.run(command).await)),
        }
    }
}

/// Runs one poll to completion while still answering the requests allowed
/// meanwhile. Returns whether stdin is still open.
#[allow(clippy::too_many_arguments)]
async fn run_poll(
    state: &mut State,
    lines: &mut Lines<BufReader<Stdin>>,
    mut shutdown: Shutdown<'_>,
    signalled: &mut bool,
    id: u64,
    bundle_id: &str,
    interval_ms: u32,
    with_fps: bool,
) -> bool {
    if interval_ms < crate::MIN_INTERVAL_MS {
        emit(&Response::error(
            id,
            error::USAGE,
            format!("intervalMs must be at least {}", crate::MIN_INTERVAL_MS),
        ));
        return true;
    }
    let conn = match state.connection().await {
        Ok(conn) => conn,
        Err(e) => {
            emit(&Response::error(id, e.code, e.message));
            return true;
        }
    };
    emit(&Response::ok(id, serde_json::json!({ "polling": true })));

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let mut cancel_tx = Some(cancel_tx);
    let mut cancel = move || {
        if let Some(tx) = cancel_tx.take() {
            let _ = tx.send(());
        }
    };
    let mut pending_stop: Option<u64> = None;
    let mut stdin_open = true;

    // Scoped so that the poll's borrow of the connection ends before the
    // connection may be dropped below
    let result = {
        let polling = poll::poll(conn, bundle_id, interval_ms, with_fps, async move {
            let _ = cancel_rx.await;
        });
        tokio::pin!(polling);

        loop {
            tokio::select! {
                biased;
                result = &mut polling => break result,
                _ = &mut shutdown, if !*signalled => {
                    *signalled = true;
                    cancel();
                }
                line = lines.next_line(), if stdin_open => match line {
                    Ok(Some(line)) => match parse_request(&line) {
                        Err(response) => emit(&response),
                        Ok(request) if !request.command.allowed_while_polling() => {
                            emit(&Response::error(
                                request.id,
                                BUSY,
                                "a poll is running: send stop first",
                            ))
                        }
                        Ok(request) => match request.command {
                            Command::Stop => {
                                pending_stop = Some(request.id);
                                cancel();
                            }
                            Command::Ping => {
                                emit(&Response::ok(request.id, serde_json::json!({ "pong": true })))
                            }
                            Command::Devices => {
                                emit(&Response::from_result(request.id, ops::devices().await))
                            }
                            _ => unreachable!("filtered by allowed_while_polling"),
                        },
                    },
                    _ => {
                        stdin_open = false;
                        cancel();
                    }
                },
            }
        }
    };

    if let Err(e) = result {
        // `poll` already reported the STREAM_ENDED marker; the connection is
        // suspect, the next request reopens it
        state.conn = None;
        emit(&StatusLine {
            detail: Some(format!("{e:?}")),
            ..StatusLine::event("ended")
        });
    }
    if let Some(stop_id) = pending_stop {
        emit(&Response::ok(
            stop_id,
            serde_json::json!({ "stopped": true }),
        ));
    }
    stdin_open
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_with_kebab_case_commands_and_camel_case_params() {
        assert_eq!(
            parse_request(r#"{"id":1,"cmd":"running-apps"}"#).unwrap(),
            Request {
                id: 1,
                command: Command::RunningApps
            }
        );
        assert_eq!(
            parse_request(r#"{"id":2,"cmd":"poll","bundleId":"com.example","intervalMs":250}"#)
                .unwrap(),
            Request {
                id: 2,
                command: Command::Poll {
                    bundle_id: "com.example".into(),
                    interval_ms: Some(250),
                    fps: None,
                }
            }
        );
        assert_eq!(
            parse_request(r#"{"id":3,"cmd":"kill","pid":42}"#).unwrap(),
            Request {
                id: 3,
                command: Command::Kill {
                    bundle_id: None,
                    pid: Some(42),
                }
            }
        );
        assert_eq!(
            parse_request(r#"{"id":4,"cmd":"apps"}"#).unwrap().command,
            Command::Apps { raw: false }
        );
    }

    #[test]
    fn answers_bad_requests_with_a_usage_error_carrying_the_id_when_there_is_one() {
        let response = parse_request(r#"{"id":7,"cmd":"dance"}"#).unwrap_err();
        assert_eq!(response.id, 7);
        assert_eq!(response.error.as_ref().unwrap().code, error::USAGE);

        let response = parse_request(r#"{"cmd":"ping"}"#).unwrap_err();
        assert_eq!(response.id, 0);

        let response = parse_request("not json").unwrap_err();
        assert_eq!(response.id, 0);
        assert!(response.error.unwrap().message.contains("invalid JSON"));
    }

    #[test]
    fn only_stop_ping_and_devices_may_interrupt_a_poll() {
        assert!(Command::Stop.allowed_while_polling());
        assert!(Command::Ping.allowed_while_polling());
        assert!(Command::Devices.allowed_while_polling());
        assert!(!Command::RunningApps.allowed_while_polling());
        assert!(!Command::Poll {
            bundle_id: "x".into(),
            interval_ms: None,
            fps: None
        }
        .allowed_while_polling());
    }

    #[test]
    fn serializes_responses_with_either_result_or_error() {
        assert_eq!(
            serde_json::to_string(&Response::ok(1, serde_json::json!({ "polling": true })))
                .unwrap(),
            r#"{"type":"response","id":1,"result":{"polling":true}}"#
        );
        assert_eq!(
            serde_json::to_string(&Response::error(2, BUSY, "a poll is running")).unwrap(),
            r#"{"type":"response","id":2,"error":{"code":"BUSY","message":"a poll is running"}}"#
        );
    }
}
