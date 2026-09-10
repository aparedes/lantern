//! lantern-ios-profiler: host-side performance profiler for iOS devices.
//!
//! Talks to a USB-connected iOS device through usbmuxd and the instruments
//! services (CoreDevice tunnel on iOS 17+, lockdown service before that) and
//! streams NDJSON measures to stdout. See README.md for the wire protocol.
//!
//! Every subcommand is a one-shot for debugging; `serve` keeps one process
//! (and one device connection) alive for a whole session, driven by NDJSON
//! requests on stdin.

mod connect;
mod convert;
mod error;
mod measure;
mod ops;
mod poll;
mod serve;
mod sysmon;

use crate::ops::OpError;

const USAGE: &str = "\
lantern-ios-profiler <command> [options]

Commands:
  devices                                   List connected iOS devices with model/OS/name (JSON)
  apps       [--udid <udid>] [--raw]        List installed user apps (JSON; --raw dumps every listing entry verbatim)
  running-apps [--udid <udid>]              Installed user apps that are currently running, with pid (JSON)
  info       [--udid <udid>]                Device hardware information (JSON)
  launch     --bundle-id <id> [--udid ...]  Launch an app, print {\"pid\": n}
  kill       --bundle-id <id> | --pid <n>   Kill an app
  poll       --bundle-id <id> [--interval-ms <n=500>] [--no-fps] [--udid ...]
                                            Stream NDJSON measures to stdout
  serve      [--udid <udid>]                Answer NDJSON requests on stdin (one process per session,
                                            see README.md); every command above is available as a request

Without --udid, exactly one USB device must be connected; with several,
the command fails (AMBIGUOUS_DEVICE) and lists their udids.

Set LANTERN_IOS_DEBUG=1 for verbose protocol logs on stderr (and a dump
of the first raw sysmontap sample during poll).
";

/// Below this the sysmontap flood outpaces the DTX reader on real devices.
pub(crate) const MIN_INTERVAL_MS: u32 = 100;

#[derive(Default)]
struct Args {
    command: String,
    bundle_id: Option<String>,
    udid: Option<String>,
    pid: Option<u64>,
    interval_ms: u32,
    no_fps: bool,
    raw: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        interval_ms: 500,
        ..Args::default()
    };
    let mut iter = std::env::args().skip(1);
    args.command = iter.next().unwrap_or_default();

    while let Some(flag) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .unwrap_or_else(|| error::fail(error::USAGE, format!("{name} requires a value")))
        };
        match flag.as_str() {
            "--bundle-id" => args.bundle_id = Some(value("--bundle-id")),
            "--udid" => args.udid = Some(value("--udid")),
            "--pid" => {
                args.pid = Some(
                    value("--pid")
                        .parse()
                        .unwrap_or_else(|_| error::fail(error::USAGE, "--pid must be a number")),
                )
            }
            "--interval-ms" => {
                args.interval_ms = value("--interval-ms")
                    .parse()
                    .unwrap_or_else(|_| error::fail(error::USAGE, "--interval-ms must be a number"))
            }
            "--no-fps" => args.no_fps = true,
            "--raw" => args.raw = true,
            other => error::fail(error::USAGE, format!("unknown flag {other}\n{USAGE}")),
        }
    }
    if args.interval_ms < MIN_INTERVAL_MS {
        error::fail(
            error::USAGE,
            format!("--interval-ms must be at least {MIN_INTERVAL_MS}"),
        );
    }
    args
}

fn require_bundle_id(args: &Args) -> &str {
    args.bundle_id
        .as_deref()
        .unwrap_or_else(|| error::fail(error::USAGE, "--bundle-id is required"))
}

/// One-shot subcommands print their JSON result, or exit with the marker.
fn finish(result: Result<serde_json::Value, OpError>) {
    match result {
        Ok(value) => println!("{}", serde_json::to_string(&value).unwrap()),
        Err(e) => error::fail(e.code, e.message),
    }
}

async fn open_connection(args: &Args) -> connect::Connection {
    ops::open_connection(args.udid.as_deref())
        .await
        .unwrap_or_else(|e| error::fail(e.code, e.message))
}

async fn cmd_poll(args: &Args) {
    let bundle_id = require_bundle_id(args);
    let mut conn = open_connection(args).await;
    let polling = poll::poll(
        &mut conn,
        bundle_id,
        args.interval_ms,
        !args.no_fps,
        poll::shutdown_signal(),
    );
    if let Err(e) = polling.await {
        error::fail(error::STREAM_ENDED, format!("{e:?}"));
    }
}

fn init_debug_tracing() {
    // LANTERN_IOS_DEBUG=1 turns on the idevice/jktcp protocol logs on
    // stderr; a filter string (e.g. "idevice=trace") can be passed instead
    // of 1 for finer control. The DVT reader logs its exit reason at warn
    // level, which is the key signal when a connection dies.
    let Ok(value) = std::env::var("LANTERN_IOS_DEBUG") else {
        return;
    };
    let filter = if value == "1" || value.is_empty() {
        "idevice=debug,jktcp=debug".to_string()
    } else {
        value
    };
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

#[tokio::main]
async fn main() {
    init_debug_tracing();
    let args = parse_args();
    match args.command.as_str() {
        "devices" => finish(ops::devices().await),
        "apps" => {
            let mut conn = open_connection(&args).await;
            finish(ops::apps(&mut conn, args.raw).await);
        }
        "running-apps" => {
            let mut conn = open_connection(&args).await;
            finish(ops::running_apps_json(&mut conn).await);
        }
        "info" => {
            let mut conn = open_connection(&args).await;
            finish(ops::info(&mut conn).await);
        }
        "launch" => {
            let bundle_id = require_bundle_id(&args);
            let mut conn = open_connection(&args).await;
            finish(ops::launch(&mut conn, bundle_id).await);
        }
        "kill" => {
            if args.pid.is_none() {
                require_bundle_id(&args);
            }
            let mut conn = open_connection(&args).await;
            finish(ops::kill(&mut conn, args.pid, args.bundle_id.as_deref()).await);
        }
        "poll" => cmd_poll(&args).await,
        "serve" => serve::serve(args.udid.as_deref()).await,
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
}
