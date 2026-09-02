//! The main polling loop: streams sysmontap (CPU/RAM/threads) and graphics
//! (CoreAnimation FPS) as two channels multiplexed over a SINGLE instruments
//! connection, and writes one NDJSON measure per sysmontap sample for the
//! target app.
//!
//! One connection is not just an optimization: on iOS 26 real devices,
//! opening several concurrent dtservicehub connections gets them closed by
//! the peer ("remote server connection closed"), so everything must share
//! one DTX connection — the same model pymobiledevice3 uses.

use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use idevice::dvt::application_listing::ApplicationListingClient;
use idevice::dvt::device_info::DeviceInfoClient;
use idevice::dvt::graphics::{GraphicsClient, GraphicsSample};
use idevice::dvt::message::Message;
use idevice::dvt::sysmontap::{SysmontapClient, SysmontapConfig};
use idevice::IdeviceError;
use plist::{Dictionary, Value};

use crate::connect::{Connection, RemoteServer};
use crate::error;
use crate::measure::{emit, MeasureLine, StatusLine};
use crate::sysmon::{
    executable_name_from_app, find_target, parse_processes, ProcessSample, PROC_ATTRS,
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extracts the Processes dictionary out of a raw sysmontap push, mirroring
/// SysmontapClient::next_sample (which we can't use directly because it
/// holds the whole connection mutably borrowed).
fn processes_from_message(msg: &Message) -> Option<&Dictionary> {
    let data = msg.data.as_ref()?;
    let rows: &[Value] = match data {
        Value::Array(arr) => arr,
        Value::Dictionary(_) => std::slice::from_ref(data),
        _ => return None,
    };
    rows.iter()
        .filter_map(|row| row.as_dictionary())
        .find_map(|dict| dict.get("Processes").and_then(|v| v.as_dictionary()))
}

/// Consecutive sysmontap read timeouts before a `stalled` status is emitted,
/// and before the poller gives up with an error. Each timeout lasts
/// `interval_ms * 4 + 2000` ms, so at the default 500 ms interval the stall
/// notice comes after ~12 s of silence and the exit after ~40 s.
const STALL_AFTER_TIMEOUTS: u32 = 3;
const FAIL_AFTER_TIMEOUTS: u32 = 10;

/// The graphics tap pushes on the device's own cadence (about one sample per
/// second, see `start_sampling(0.0)`), regardless of `interval_ms`.
const GRAPHICS_PERIOD_MS: u32 = 1000;

/// An FPS sample older than this is dropped rather than reported as if it
/// were fresh (graphics pushes stop while the app is idle or backgrounded).
/// It tolerates one late graphics push at any `interval_ms`, so a short
/// polling interval does not drop FPS from most measures just because the
/// graphics tap is slower than sysmontap.
fn fps_max_age(interval_ms: u32) -> Duration {
    Duration::from_millis(u64::from((interval_ms * 3).max(GRAPHICS_PERIOD_MS * 2)))
}

#[derive(Debug, PartialEq, Eq)]
enum TimeoutVerdict {
    /// Keep waiting quietly.
    Wait,
    /// Emit the `stalled` status once.
    Stalled,
    /// Give up: the stream is dead.
    Fail,
}

fn timeout_verdict(consecutive_timeouts: u32) -> TimeoutVerdict {
    if consecutive_timeouts >= FAIL_AFTER_TIMEOUTS {
        TimeoutVerdict::Fail
    } else if consecutive_timeouts == STALL_AFTER_TIMEOUTS {
        TimeoutVerdict::Stalled
    } else {
        TimeoutVerdict::Wait
    }
}

/// The last FPS sample, if it is recent enough to still describe the app.
fn fresh_fps(last_fps: Option<(f64, Instant)>, now: Instant, max_age: Duration) -> Option<f64> {
    let (fps, seen_at) = last_fps?;
    (now.saturating_duration_since(seen_at) <= max_age).then_some(fps)
}

/// Channel codes on the shared connection. make_channel allocates codes
/// deterministically starting at 1, bumping the counter on every attempt
/// (even a failed one), so the codes are known from our creation order.
struct Channels {
    sysmontap: i32,
    graphics: Option<i32>,
}

async fn resolve_executable_name(rs: &mut RemoteServer, bundle_id: &str) -> Option<String> {
    let mut listing = match ApplicationListingClient::new(rs).await {
        Ok(l) => l,
        Err(e) => {
            error::report(error::SERVICE_FAILED, format!("application listing: {e:?}"));
            return None;
        }
    };
    match listing.installed_applications().await {
        Ok(apps) => apps
            .iter()
            .find_map(|app| executable_name_from_app(app, bundle_id)),
        Err(e) => {
            error::report(error::SERVICE_FAILED, format!("application listing: {e:?}"));
            None
        }
    }
}

/// Queries the device for the attribute names its sysmontap supports,
/// mirroring pymobiledevice3's Sysmontap.create: it always configures the
/// tap with the device's own full lists, never a hand-picked subset. iOS 26
/// closes the connection after `start` when it dislikes the tap config, so
/// matching the known-good client exactly matters.
async fn query_sysmon_attributes(rs: &mut RemoteServer) -> Option<(Vec<String>, Vec<String>)> {
    let mut info = match DeviceInfoClient::new(rs).await {
        Ok(client) => client,
        Err(e) => {
            error::report(error::SERVICE_FAILED, format!("device info: {e:?}"));
            return None;
        }
    };
    let process = match info.sysmon_process_attributes().await {
        Ok(attrs) => attrs,
        Err(e) => {
            error::report(
                error::SERVICE_FAILED,
                format!("sysmonProcessAttributes: {e:?}"),
            );
            return None;
        }
    };
    let system = match info.sysmon_system_attributes().await {
        Ok(attrs) => attrs,
        Err(e) => {
            error::report(
                error::SERVICE_FAILED,
                format!("sysmonSystemAttributes: {e:?}"),
            );
            return None;
        }
    };
    Some((process, system))
}

/// Creates and starts the sysmontap + graphics channels. Returns their codes.
/// `next_channel` must be the code make_channel will hand out next.
async fn start_taps(
    rs: &mut RemoteServer,
    interval_ms: u32,
    proc_attrs: Vec<String>,
    sys_attrs: Vec<String>,
    mut next_channel: i32,
    with_fps: bool,
) -> Result<Channels, IdeviceError> {
    // Create and configure every channel first; start the sysmontap flood
    // LAST so no control-plane request has to race the heavy data stream.
    let sysmontap = next_channel;
    next_channel += 1;
    {
        let mut client = SysmontapClient::new(rs).await?;
        client
            .set_config(&SysmontapConfig {
                interval_ms,
                process_attributes: proc_attrs,
                system_attributes: sys_attrs,
            })
            .await?;
    }

    let graphics = if with_fps {
        match GraphicsClient::new(rs).await {
            Ok(mut client) => match client.start_sampling(0.0).await {
                Ok(()) => Some(next_channel),
                Err(e) => {
                    error::report(error::SERVICE_FAILED, format!("graphics sampling: {e:?}"));
                    None
                }
            },
            Err(e) => {
                // FPS is best-effort: measures still flow without it.
                error::report(error::SERVICE_FAILED, format!("graphics channel: {e:?}"));
                None
            }
        }
    } else {
        None
    };

    // The wrapper's start() would consume the initial ack; sent raw instead,
    // the ack lands in the channel queue and the poll loop discards it.
    rs.call_method(sysmontap, Some(Value::String("start".into())), None, false)
        .await?;

    Ok(Channels {
        sysmontap,
        graphics,
    })
}

/// Streams measures for `bundle_id` until `cancel` completes (a clean stop,
/// `Ok`) or the stream dies (`Err`, after a `STREAM_ENDED` marker). The
/// one-shot `poll` subcommand cancels on SIGINT/SIGTERM (`shutdown_signal`);
/// `serve` cancels on a `stop` request.
pub async fn poll(
    conn: &mut Connection,
    bundle_id: &str,
    interval_ms: u32,
    with_fps: bool,
    cancel: impl Future<Output = ()>,
) -> Result<(), IdeviceError> {
    let mut rs = conn.remote_server().await?;

    // Channel codes are deterministic: every client-creation attempt bumps
    // the counter exactly once, succeed or fail. Creation order below:
    //   1 app listing, 2 device info, 3 sysmontap, 4 graphics (if enabled).
    let executable_name = resolve_executable_name(&mut rs, bundle_id).await;
    if executable_name.is_none() {
        emit(&StatusLine {
            detail: Some(format!(
                "executable name for {bundle_id} not found; matching by bundle id"
            )),
            ..StatusLine::event("warning")
        });
    }

    let (proc_attrs, sys_attrs) = query_sysmon_attributes(&mut rs).await.unwrap_or_else(|| {
        (
            PROC_ATTRS.iter().map(|s| s.to_string()).collect(),
            Vec::new(),
        )
    });

    let channels = start_taps(
        &mut rs,
        interval_ms,
        proc_attrs.clone(),
        sys_attrs,
        3,
        with_fps,
    )
    .await?;

    emit(&StatusLine {
        detail: Some(format!(
            "polling {bundle_id} every {interval_ms}ms (tunnel: {}, fps: {})",
            if conn.uses_core_device_tunnel() {
                "CoreDevice"
            } else {
                "lockdown"
            },
            if channels.graphics.is_some() {
                "on"
            } else {
                "unavailable"
            },
        )),
        ..StatusLine::event("started")
    });

    let debug_raw = std::env::var("LANTERN_IOS_DEBUG").is_ok();
    let mut first_sample_dumped = false;
    let mut last_fps: Option<(f64, Instant)> = None;
    let fps_max_age = fps_max_age(interval_ms);
    let mut graphics_alive = channels.graphics;
    let mut target_seen = false;
    let read_timeout = Duration::from_millis(u64::from(interval_ms) * 4 + 2000);
    let mut consecutive_timeouts: u32 = 0;

    tokio::pin!(cancel);

    let result = loop {
        // Wait for the next sysmontap push; it paces the loop at interval_ms.
        let sysmon_msg = tokio::select! {
            biased;
            _ = &mut cancel => break Ok(()),
            read = tokio::time::timeout(read_timeout, rs.read_message(channels.sysmontap)) => match read {
                Ok(Ok(msg)) => {
                    consecutive_timeouts = 0;
                    Some(msg)
                }
                Ok(Err(e)) => {
                    error::report(error::STREAM_ENDED, format!("sysmontap: {e:?}"));
                    break Err(e);
                }
                Err(_timeout) => {
                    consecutive_timeouts += 1;
                    let silence = read_timeout * consecutive_timeouts;
                    match timeout_verdict(consecutive_timeouts) {
                        TimeoutVerdict::Wait => {}
                        TimeoutVerdict::Stalled => emit(&StatusLine {
                            detail: Some(format!(
                                "no sysmontap sample for {}s",
                                silence.as_secs()
                            )),
                            ..StatusLine::event("stalled")
                        }),
                        TimeoutVerdict::Fail => {
                            error::report(
                                error::STREAM_ENDED,
                                format!("sysmontap: no sample for {}s", silence.as_secs()),
                            );
                            break Err(IdeviceError::Timeout);
                        }
                    }
                    None
                }
            },
        };

        // Drain any queued graphics frames so fps is fresh for this measure.
        while let Some(code) = graphics_alive {
            match tokio::time::timeout(Duration::from_millis(1), rs.read_message(code)).await {
                Ok(Ok(msg)) => {
                    if let Some(data) = msg.data {
                        if let Ok(sample) = GraphicsSample::from_plist(data) {
                            last_fps = Some((sample.fps, Instant::now()));
                        }
                    }
                }
                Ok(Err(e)) => {
                    error::report(error::STREAM_ENDED, format!("graphics: {e:?}"));
                    last_fps = None;
                    graphics_alive = None;
                }
                Err(_empty) => break,
            }
        }

        let Some(msg) = sysmon_msg else { continue };
        let Some(processes) = processes_from_message(&msg) else {
            // Not a data row — a start ack or a DTTapMessage the archive
            // decoder can't resolve. In debug mode dump it as a plain plist,
            // which exposes the archive's string table (error text included).
            if debug_raw {
                if let Some(raw) = &msg.raw_data {
                    let decoded = plist::from_bytes::<plist::Value>(raw)
                        .map(|v| format!("{v:?}"))
                        .unwrap_or_else(|e| format!("<unparseable: {e}>"));
                    eprintln!(
                        "LANTERN_IOS_DEBUG tap control message: {}",
                        &decoded[..decoded.len().min(4000)]
                    );
                }
            }
            continue;
        };

        if debug_raw && !first_sample_dumped {
            first_sample_dumped = true;
            let raw = format!("{:?}", msg.data);
            eprintln!(
                "LANTERN_IOS_DEBUG first sysmontap sample: {}",
                &raw[..raw.len().min(4000)]
            );
        }

        let parsed: Vec<ProcessSample> = parse_processes(processes, &proc_attrs);
        match find_target(&parsed, executable_name.as_deref(), bundle_id) {
            Some(process) => {
                if !target_seen {
                    target_seen = true;
                    emit(&StatusLine {
                        pid: Some(process.pid),
                        name: Some(&process.name),
                        ..StatusLine::event("target")
                    });
                }
                emit(&MeasureLine::new(
                    now_ms(),
                    process,
                    fresh_fps(last_fps, Instant::now(), fps_max_age),
                ));
            }
            None => {
                if target_seen {
                    target_seen = false;
                    emit(&StatusLine::event("targetLost"));
                }
            }
        }
    };

    // Best-effort tap teardown; the connection closes when rs drops. Bounded:
    // a dead connection must not keep the process (and the caller's stop())
    // hanging on a write that will never complete.
    let teardown_timeout = Duration::from_secs(2);
    let _ = tokio::time::timeout(
        teardown_timeout,
        rs.call_method(
            channels.sysmontap,
            Some(Value::String("stop".into())),
            None,
            false,
        ),
    )
    .await;
    if let Some(code) = channels.graphics {
        let _ = tokio::time::timeout(
            teardown_timeout,
            rs.call_method(
                code,
                Some(Value::String("stopSampling".into())),
                None,
                false,
            ),
        )
        .await;
    }

    emit(&StatusLine::event("stopped"));
    result
}

/// Resolves on SIGINT or SIGTERM.
pub async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use idevice::dvt::message::{MessageHeader, PayloadHeader};

    fn message_with_data(data: Option<Value>) -> Message {
        Message::new(
            MessageHeader::new(0, 1, 1, 0, 1, false),
            PayloadHeader::method_invocation(),
            None,
            data,
        )
    }

    fn sample_row() -> Value {
        let mut processes = Dictionary::new();
        processes.insert("42".into(), Value::Array(vec![Value::Integer(42.into())]));
        let mut row = Dictionary::new();
        row.insert("Processes".into(), Value::Dictionary(processes));
        Value::Dictionary(row)
    }

    #[test]
    fn extracts_processes_from_array_of_rows() {
        let msg = message_with_data(Some(Value::Array(vec![
            Value::String("noise".into()),
            sample_row(),
        ])));
        let processes = processes_from_message(&msg).unwrap();
        assert!(processes.contains_key("42"));
    }

    #[test]
    fn extracts_processes_from_bare_dictionary() {
        let msg = message_with_data(Some(sample_row()));
        assert!(processes_from_message(&msg).is_some());
    }

    #[test]
    fn stalls_once_then_fails_after_enough_timeouts() {
        assert_eq!(timeout_verdict(1), TimeoutVerdict::Wait);
        assert_eq!(
            timeout_verdict(STALL_AFTER_TIMEOUTS),
            TimeoutVerdict::Stalled
        );
        // Only one stalled notice, then quiet until the failure threshold.
        assert_eq!(
            timeout_verdict(STALL_AFTER_TIMEOUTS + 1),
            TimeoutVerdict::Wait
        );
        assert_eq!(timeout_verdict(FAIL_AFTER_TIMEOUTS), TimeoutVerdict::Fail);
        assert_eq!(
            timeout_verdict(FAIL_AFTER_TIMEOUTS + 5),
            TimeoutVerdict::Fail
        );
    }

    #[test]
    fn fps_max_age_covers_the_graphics_cadence_at_short_intervals() {
        // The graphics tap is not paced by interval_ms: at the minimum interval the window
        // must still span a couple of its ~1 s pushes
        assert_eq!(fps_max_age(100), Duration::from_millis(2000));
        assert_eq!(fps_max_age(500), Duration::from_millis(2000));
        // ...while long intervals keep a few intervals worth of tolerance
        assert_eq!(fps_max_age(1000), Duration::from_millis(3000));
    }

    #[test]
    fn drops_stale_fps() {
        let now = Instant::now();
        let max_age = Duration::from_millis(1500);
        assert_eq!(fresh_fps(None, now, max_age), None);
        assert_eq!(fresh_fps(Some((59.5, now)), now, max_age), Some(59.5));
        assert_eq!(
            fresh_fps(
                Some((59.5, now)),
                now + Duration::from_millis(1500),
                max_age
            ),
            Some(59.5)
        );
        assert_eq!(
            fresh_fps(
                Some((59.5, now)),
                now + Duration::from_millis(1501),
                max_age
            ),
            None
        );
    }

    #[test]
    fn ignores_messages_without_processes() {
        assert!(processes_from_message(&message_with_data(None)).is_none());
        assert!(
            processes_from_message(&message_with_data(Some(Value::String("ack".into())))).is_none()
        );
    }
}
