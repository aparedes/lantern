//! The device operations behind both the one-shot subcommands (main.rs) and
//! the `serve` request loop (serve.rs). They return their JSON result or an
//! `OpError` carrying the marker code, so that the CLI can exit with a marker
//! while `serve` answers with an error response and keeps running.

use idevice::dvt::application_listing::ApplicationListingClient;
use idevice::dvt::device_info::{DeviceInfoClient, RunningProcess};
use idevice::dvt::process_control::ProcessControlClient;
use plist::{Dictionary, Value};
use serde_json::Value as Json;

use crate::connect::{self, Connection, OpenError, PickError};
use crate::convert::plist_to_json;
use crate::error;
use crate::sysmon;

/// A failed operation: `code` is the stderr marker / response error code.
#[derive(Debug)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn service(context: &str, e: impl std::fmt::Debug) -> Self {
        Self::new(error::SERVICE_FAILED, format!("{context}: {e:?}"))
    }
}

pub async fn open_connection(udid: Option<&str>) -> Result<Connection, OpError> {
    Connection::open(udid).await.map_err(|e| match e {
        OpenError::Pick(pick @ PickError::Ambiguous(_)) => {
            OpError::new(error::AMBIGUOUS_DEVICE, pick.to_string())
        }
        OpenError::Pick(pick) => OpError::new(error::NO_DEVICE, pick.to_string()),
        OpenError::Idevice(e) => OpError::new(
            error::NO_DEVICE,
            format!("could not connect to device: {e:?}"),
        ),
    })
}

/// Every usbmuxd device with its best-effort lockdown description.
pub async fn devices() -> Result<Json, OpError> {
    let devices = connect::list_devices()
        .await
        .map_err(|e| OpError::new(error::NO_DEVICE, format!("usbmuxd: {e:?}")))?;
    let mut json: Vec<Json> = Vec::with_capacity(devices.len());
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
    Ok(Json::Array(json))
}

async fn remote_server(conn: &mut Connection) -> Result<connect::RemoteServer, OpError> {
    conn.remote_server()
        .await
        .map_err(|e| OpError::service("instruments", e))
}

async fn installed_applications(
    server: &mut connect::RemoteServer,
) -> Result<Vec<Dictionary>, OpError> {
    let mut listing = ApplicationListingClient::new(server)
        .await
        .map_err(|e| OpError::service("application listing", e))?;
    listing
        .installed_applications()
        .await
        .map_err(|e| OpError::service("application listing", e))
}

async fn running_processes(
    server: &mut connect::RemoteServer,
) -> Result<Vec<RunningProcess>, OpError> {
    let mut info = DeviceInfoClient::new(server)
        .await
        .map_err(|e| OpError::service("device info", e))?;
    info.running_processes()
        .await
        .map_err(|e| OpError::service("device info", e))
}

/// Installed user apps; `raw` dumps every listing entry verbatim.
pub async fn apps(conn: &mut Connection, raw: bool) -> Result<Json, OpError> {
    let mut server = remote_server(conn).await?;
    let apps = installed_applications(&mut server).await?;

    if raw {
        let json: Vec<Json> = apps
            .iter()
            .map(|app| plist_to_json(&Value::Dictionary(app.clone())))
            .collect();
        return Ok(Json::Array(json));
    }

    let mut infos: Vec<sysmon::AppInfo> = apps
        .iter()
        .filter(|app| sysmon::is_user_visible(app))
        .filter_map(sysmon::app_info)
        .collect();
    sort_by_name(&mut infos, |info| &info.name);
    Ok(serde_json::to_value(infos).expect("serialize app infos"))
}

/// Sorts a listing the way a picker should show it: case-insensitively by
/// display name, with the original order kept for ties.
fn sort_by_name<T>(items: &mut [T], name: impl Fn(&T) -> &str) {
    items.sort_by_key(|item| name(item).to_lowercase());
}

/// Joins the installed-app listing with the device's process list. An app is
/// running when a process matches its executable name; mirrors `resolve_pid`,
/// with the listing's own `is_application` flag as an extra guard.
pub fn running_apps(
    apps: &[Dictionary],
    processes: &[RunningProcess],
) -> Vec<(sysmon::AppInfo, u32)> {
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

/// Installed user apps that are running right now, with their pid.
pub async fn running_apps_json(conn: &mut Connection) -> Result<Json, OpError> {
    // One instruments connection, two channels: iOS closes concurrent
    // dtservicehub connections (see connect::Connection::remote_server).
    let mut server = remote_server(conn).await?;
    let apps = installed_applications(&mut server).await?;
    let processes = running_processes(&mut server).await?;

    let json: Vec<Json> = running_apps(&apps, &processes)
        .into_iter()
        .map(|(app, pid)| {
            let mut value = serde_json::to_value(app).expect("serialize app info");
            if let Some(object) = value.as_object_mut() {
                object.insert("pid".into(), serde_json::json!(pid));
            }
            value
        })
        .collect();
    Ok(Json::Array(json))
}

/// The device's hardware information dictionary, as JSON.
pub async fn info(conn: &mut Connection) -> Result<Json, OpError> {
    let mut server = remote_server(conn).await?;
    let mut info = DeviceInfoClient::new(&mut server)
        .await
        .map_err(|e| OpError::service("device info", e))?;
    let hardware = info
        .hardware_information()
        .await
        .map_err(|e| OpError::service("device info", e))?;
    Ok(plist_to_json(&Value::Dictionary(hardware)))
}

/// Launches an app, returning `{"pid": n}`.
pub async fn launch(conn: &mut Connection, bundle_id: &str) -> Result<Json, OpError> {
    let mut server = remote_server(conn).await?;
    let mut control = ProcessControlClient::new(&mut server)
        .await
        .map_err(|e| OpError::service("process control", e))?;
    let pid = control
        .launch_app(bundle_id, None, None, false, false)
        .await
        .map_err(|e| OpError::new(error::APP_NOT_FOUND, format!("launch {bundle_id}: {e:?}")))?;
    Ok(serde_json::json!({ "pid": pid }))
}

async fn resolve_pid(conn: &mut Connection, bundle_id: &str) -> Option<u64> {
    let mut server = conn.remote_server().await.ok()?;
    let executable_name = {
        let apps = installed_applications(&mut server).await.ok()?;
        apps.iter()
            .find_map(|app| sysmon::executable_name_from_app(app, bundle_id))
    };
    let processes = running_processes(&mut server).await.ok()?;
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

/// Kills an app by pid, or by bundle id (resolved through the process list).
pub async fn kill(
    conn: &mut Connection,
    pid: Option<u64>,
    bundle_id: Option<&str>,
) -> Result<Json, OpError> {
    let pid = match (pid, bundle_id) {
        (Some(pid), _) => pid,
        (None, Some(bundle_id)) => resolve_pid(conn, bundle_id).await.ok_or_else(|| {
            OpError::new(error::APP_NOT_FOUND, format!("{bundle_id} is not running"))
        })?,
        (None, None) => {
            return Err(OpError::new(
                error::USAGE,
                "kill needs a bundle id or a pid",
            ))
        }
    };
    let mut server = remote_server(conn).await?;
    let mut control = ProcessControlClient::new(&mut server)
        .await
        .map_err(|e| OpError::service("process control", e))?;
    control
        .kill_app(pid)
        .await
        .map_err(|e| OpError::service(&format!("kill {pid}"), e))?;
    Ok(serde_json::json!({ "killed": pid }))
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
