//! lantern-ios-profiler: host-side performance profiler for iOS devices.
//!
//! Talks to a USB-connected iOS device through usbmuxd and the instruments
//! services (CoreDevice tunnel on iOS 17+, lockdown service before that) and
//! streams NDJSON measures to stdout. See README.md for the wire protocol.

mod connect;
mod convert;
mod error;
mod measure;
mod poll;
mod sysmon;

use idevice::dvt::application_listing::ApplicationListingClient;
use idevice::dvt::device_info::{DeviceInfoClient, RunningProcess};
use idevice::dvt::process_control::ProcessControlClient;
use plist::{Dictionary, Value};

use crate::connect::{Connection, OpenError, PickError};
use crate::convert::plist_to_json;

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

Without --udid, exactly one USB device must be connected; with several,
the command fails (AMBIGUOUS_DEVICE) and lists their udids.

Set LANTERN_IOS_DEBUG=1 for verbose protocol logs on stderr (and a dump
of the first raw sysmontap sample during poll).
";

/// Below this the sysmontap flood outpaces the DTX reader on real devices.
const MIN_INTERVAL_MS: u32 = 100;

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

async fn open_connection(args: &Args) -> Connection {
    Connection::open(args.udid.as_deref())
        .await
        .unwrap_or_else(|e| match e {
            OpenError::Pick(pick @ PickError::Ambiguous(_)) => {
                error::fail(error::AMBIGUOUS_DEVICE, pick)
            }
            OpenError::Pick(pick) => error::fail(error::NO_DEVICE, pick),
            OpenError::Idevice(e) => error::fail(
                error::NO_DEVICE,
                format!("could not connect to device: {e:?}"),
            ),
        })
}

async fn cmd_devices() {
    let devices = connect::list_devices()
        .await
        .unwrap_or_else(|e| error::fail(error::NO_DEVICE, format!("usbmuxd: {e:?}")));
    let mut json: Vec<serde_json::Value> = Vec::with_capacity(devices.len());
    for device in &devices {
        // Best effort: an unpaired device still gets listed, with null values.
        let described = connect::describe_device(device).await;
        json.push(serde_json::json!({
            "udid": device.udid,
            "deviceId": device.device_id,
            "connectionType": format!("{:?}", device.connection_type),
            "productType": described.product_type,
            "productVersion": described.product_version,
            "deviceName": described.device_name,
        }));
    }
    println!("{}", serde_json::to_string(&json).unwrap());
}

async fn cmd_apps(args: &Args) {
    let mut conn = open_connection(args).await;
    let mut server = conn
        .remote_server()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("instruments: {e:?}")));
    let mut listing = ApplicationListingClient::new(&mut server)
        .await
        .unwrap_or_else(|e| {
            error::fail(error::SERVICE_FAILED, format!("application listing: {e:?}"))
        });
    let apps = listing.installed_applications().await.unwrap_or_else(|e| {
        error::fail(error::SERVICE_FAILED, format!("application listing: {e:?}"))
    });

    if args.raw {
        let json: Vec<serde_json::Value> = apps
            .iter()
            .map(|app| plist_to_json(&Value::Dictionary(app.clone())))
            .collect();
        println!("{}", serde_json::to_string(&json).unwrap());
        return;
    }

    let mut infos: Vec<sysmon::AppInfo> = apps
        .iter()
        .filter(|app| sysmon::is_user_visible(app))
        .filter_map(sysmon::app_info)
        .collect();
    sort_by_name(&mut infos, |info| &info.name);
    println!("{}", serde_json::to_string(&infos).unwrap());
}

/// Sorts a listing the way a picker should show it: case-insensitively by
/// display name, with the original order kept for ties.
fn sort_by_name<T>(items: &mut [T], name: impl Fn(&T) -> &str) {
    items.sort_by_key(|item| name(item).to_lowercase());
}

/// Joins the installed-app listing with the device's process list. An app is
/// running when a process matches its executable name; mirrors `resolve_pid`,
/// with the listing's own `is_application` flag as an extra guard.
fn running_apps(apps: &[Dictionary], processes: &[RunningProcess]) -> Vec<(sysmon::AppInfo, u32)> {
    let mut running: Vec<(sysmon::AppInfo, u32)> = apps
        .iter()
        .filter(|app| sysmon::is_user_visible(app))
        .filter_map(sysmon::app_info)
        .filter_map(|info| {
            let executable_name = info.executable_name.as_deref()?;
            let process = processes
                .iter()
                .find(|p| p.is_application && p.name == executable_name)?;
            Some((info, process.pid))
        })
        .collect();
    sort_by_name(&mut running, |(info, _)| &info.name);
    running
}

async fn cmd_running_apps(args: &Args) {
    let mut conn = open_connection(args).await;
    // One instruments connection, two channels: iOS closes concurrent
    // dtservicehub connections (see connect::Connection::remote_server).
    let mut server = conn
        .remote_server()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("instruments: {e:?}")));
    let apps = {
        let mut listing = ApplicationListingClient::new(&mut server)
            .await
            .unwrap_or_else(|e| {
                error::fail(error::SERVICE_FAILED, format!("application listing: {e:?}"))
            });
        listing.installed_applications().await.unwrap_or_else(|e| {
            error::fail(error::SERVICE_FAILED, format!("application listing: {e:?}"))
        })
    };
    let mut info = DeviceInfoClient::new(&mut server)
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("device info: {e:?}")));
    let processes = info
        .running_processes()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("device info: {e:?}")));

    let json: Vec<serde_json::Value> = running_apps(&apps, &processes)
        .into_iter()
        .map(|(app, pid)| {
            let mut value = serde_json::to_value(app).unwrap();
            if let Some(object) = value.as_object_mut() {
                object.insert("pid".into(), serde_json::json!(pid));
            }
            value
        })
        .collect();
    println!("{}", serde_json::to_string(&json).unwrap());
}

async fn cmd_info(args: &Args) {
    let mut conn = open_connection(args).await;
    let mut server = conn
        .remote_server()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("instruments: {e:?}")));
    let mut info = DeviceInfoClient::new(&mut server)
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("device info: {e:?}")));
    let hardware = info
        .hardware_information()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("device info: {e:?}")));
    println!(
        "{}",
        serde_json::to_string(&plist_to_json(&Value::Dictionary(hardware))).unwrap()
    );
}

async fn cmd_launch(args: &Args) {
    let bundle_id = require_bundle_id(args);
    let mut conn = open_connection(args).await;
    let mut server = conn
        .remote_server()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("instruments: {e:?}")));
    let mut control = ProcessControlClient::new(&mut server)
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("process control: {e:?}")));
    let pid = control
        .launch_app(bundle_id, None, None, false, false)
        .await
        .unwrap_or_else(|e| {
            error::fail(error::APP_NOT_FOUND, format!("launch {bundle_id}: {e:?}"))
        });
    println!("{}", serde_json::json!({ "pid": pid }));
}

async fn resolve_pid(conn: &mut Connection, bundle_id: &str) -> Option<u64> {
    let mut server = conn.remote_server().await.ok()?;
    let executable_name = {
        let mut listing = ApplicationListingClient::new(&mut server).await.ok()?;
        let apps = listing.installed_applications().await.ok()?;
        apps.iter()
            .find_map(|app| sysmon::executable_name_from_app(app, bundle_id))
    };
    let mut info = DeviceInfoClient::new(&mut server).await.ok()?;
    let processes = info.running_processes().await.ok()?;
    processes
        .iter()
        .find(|p| {
            executable_name.as_deref().is_some_and(|exe| p.name == exe)
                || p.name == bundle_id
                || p.real_app_name.ends_with(&format!("/{}", p.name))
                    && executable_name.is_none()
                    && bundle_id.rsplit('.').next().is_some_and(|c| p.name == c)
        })
        .map(|p| p.pid as u64)
}

async fn cmd_kill(args: &Args) {
    let mut conn = open_connection(args).await;
    let pid = match args.pid {
        Some(pid) => pid,
        None => {
            let bundle_id = require_bundle_id(args);
            resolve_pid(&mut conn, bundle_id).await.unwrap_or_else(|| {
                error::fail(error::APP_NOT_FOUND, format!("{bundle_id} is not running"))
            })
        }
    };
    let mut server = conn
        .remote_server()
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("instruments: {e:?}")));
    let mut control = ProcessControlClient::new(&mut server)
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("process control: {e:?}")));
    control
        .kill_app(pid)
        .await
        .unwrap_or_else(|e| error::fail(error::SERVICE_FAILED, format!("kill {pid}: {e:?}")));
    println!("{}", serde_json::json!({ "killed": pid }));
}

async fn cmd_poll(args: &Args) {
    let bundle_id = require_bundle_id(args);
    let mut conn = open_connection(args).await;
    if let Err(e) = poll::poll(&mut conn, bundle_id, args.interval_ms, !args.no_fps).await {
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
        "devices" => cmd_devices().await,
        "apps" => cmd_apps(&args).await,
        "running-apps" => cmd_running_apps(&args).await,
        "info" => cmd_info(&args).await,
        "launch" => cmd_launch(&args).await,
        "kill" => cmd_kill(&args).await,
        "poll" => cmd_poll(&args).await,
        _ => {
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing_row(bundle_id: &str, name: &str, executable: &str) -> Dictionary {
        let mut app = Dictionary::new();
        app.insert("CFBundleIdentifier".into(), Value::String(bundle_id.into()));
        app.insert("DisplayName".into(), Value::String(name.into()));
        app.insert("ExecutableName".into(), Value::String(executable.into()));
        app.insert("Type".into(), Value::String("User".into()));
        app
    }

    fn process(pid: u32, name: &str, is_application: bool) -> RunningProcess {
        RunningProcess {
            pid,
            name: name.into(),
            real_app_name: format!("/private/var/containers/{name}.app/{name}"),
            is_application,
            start_page_count: 0,
        }
    }

    #[test]
    fn joins_installed_apps_with_running_processes() {
        let apps = vec![
            listing_row("com.example.zeta", "Zeta", "Zeta"),
            listing_row("com.example.alpha", "Alpha", "AlphaBin"),
        ];
        let processes = vec![
            process(11, "AlphaBin", true),
            process(12, "SpringBoard", false),
        ];

        let running = running_apps(&apps, &processes);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].0.bundle_id, "com.example.alpha");
        assert_eq!(running[0].0.name, "Alpha");
        assert_eq!(running[0].1, 11);
    }

    #[test]
    fn skips_non_application_processes_and_hidden_rows() {
        let apps = vec![listing_row("com.example.alpha", "Alpha", "AlphaBin")];
        // Same name, but the device says it is not an application.
        assert!(running_apps(&apps, &[process(11, "AlphaBin", false)]).is_empty());

        let mut extension = listing_row("com.example.alpha.widget", "Widget", "WidgetBin");
        extension.insert("Type".into(), Value::String("PluginKit".into()));
        assert!(running_apps(&[extension], &[process(13, "WidgetBin", true)]).is_empty());
    }

    #[test]
    fn sorts_running_apps_case_insensitively_by_name() {
        let apps = vec![
            listing_row("com.example.zeta", "zeta", "ZetaBin"),
            listing_row("com.example.alpha", "Alpha", "AlphaBin"),
        ];
        let processes = vec![process(1, "ZetaBin", true), process(2, "AlphaBin", true)];

        let running = running_apps(&apps, &processes);
        let names: Vec<&str> = running.iter().map(|(app, _)| app.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "zeta"]);
    }
}
