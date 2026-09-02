//! Connection bootstrap: usbmuxd discovery, then either the iOS 17+
//! CoreDevice tunnel (userspace TCP, no sudo, no TUN device) or the legacy
//! lockdown instruments service for iOS < 17.
//!
//! iOS 17+ path: usbmuxd -> lockdown -> CoreDeviceProxy -> CDTunnel handshake
//! -> jktcp userspace TCP stack over the tunnel's raw IPv6 packets -> RSD
//! handshake -> com.apple.instruments.dtservicehub.
//!
//! Requires the personalized Developer Disk Image to be mounted (Xcode and
//! devicectl do this automatically; `pymobiledevice3 mounter auto-mount` also
//! works). If dtservicehub is missing from RSD, that's the likely cause.

use idevice::dvt::remote_server::RemoteServerClient;
use idevice::provider::{IdeviceProvider, UsbmuxdProvider};
use idevice::services::lockdown::LockdownClient;
use idevice::services::rsd::RsdHandshake;
use idevice::tcp::handle::AdapterHandle;
use idevice::usbmuxd::{
    Connection as MuxConnection, UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice,
};

use idevice::core_device_proxy::CoreDeviceProxy;
use idevice::{IdeviceError, IdeviceService, ReadWrite};

pub type RemoteServer = RemoteServerClient<Box<dyn ReadWrite>>;

pub struct Connection {
    provider: UsbmuxdProvider,
    tunnel: Option<Tunnel>,
}

struct Tunnel {
    handle: AdapterHandle,
    rsd: RsdHandshake,
}

pub async fn list_devices() -> Result<Vec<UsbmuxdDevice>, IdeviceError> {
    let mut mux = UsbmuxdConnection::default().await?;
    mux.get_devices().await
}

/// Why no single device could be picked out of the usbmuxd listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickError {
    /// The requested udid is not connected; carries the connected udids.
    NotFound {
        udid: String,
        connected: Vec<String>,
    },
    /// Nothing is connected over USB.
    NoDevice,
    /// Several USB devices and no `--udid` to choose between them.
    Ambiguous(Vec<String>),
}

impl std::fmt::Display for PickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PickError::NotFound { udid, connected } if connected.is_empty() => {
                write!(f, "device {udid} is not connected (no device connected)")
            }
            PickError::NotFound { udid, connected } => write!(
                f,
                "device {udid} is not connected (connected: {})",
                connected.join(", ")
            ),
            PickError::NoDevice => write!(f, "no iOS device connected over USB"),
            PickError::Ambiguous(udids) => write!(
                f,
                "several iOS devices are connected ({}): pass --udid",
                udids.join(", ")
            ),
        }
    }
}

/// The device a command works with, mirroring the TypeScript side's rule so
/// both agree: an explicit udid must be connected; otherwise exactly one USB
/// device must be, and picking silently among several is an error. Network
/// entries duplicate USB ones and are only considered for an explicit udid.
pub fn pick_device(
    devices: &[UsbmuxdDevice],
    udid: Option<&str>,
) -> Result<UsbmuxdDevice, PickError> {
    let usb: Vec<&UsbmuxdDevice> = devices
        .iter()
        .filter(|d| matches!(d.connection_type, MuxConnection::Usb))
        .collect();

    if let Some(udid) = udid {
        return usb
            .iter()
            .copied()
            .find(|d| d.udid == udid)
            .or_else(|| devices.iter().find(|d| d.udid == udid))
            .cloned()
            .ok_or_else(|| PickError::NotFound {
                udid: udid.to_string(),
                connected: udids(&usb),
            });
    }

    match usb.as_slice() {
        [] => Err(PickError::NoDevice),
        [device] => Ok((*device).clone()),
        _ => Err(PickError::Ambiguous(udids(&usb))),
    }
}

fn udids(devices: &[&UsbmuxdDevice]) -> Vec<String> {
    let mut udids: Vec<String> = devices.iter().map(|d| d.udid.clone()).collect();
    udids.sort();
    udids.dedup();
    udids
}

/// What can go wrong before a device is even reached.
#[derive(Debug)]
pub enum OpenError {
    Pick(PickError),
    Idevice(IdeviceError),
}

impl From<IdeviceError> for OpenError {
    fn from(error: IdeviceError) -> Self {
        OpenError::Idevice(error)
    }
}

/// Lockdown values used to describe a device (model, OS, name). Best effort:
/// `None` when the device is not paired or lockdown is unreachable — `devices`
/// must still list the device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceDescription {
    pub product_type: Option<String>,
    pub product_version: Option<String>,
    pub device_name: Option<String>,
}

/// Reads `ProductType` / `ProductVersion` / `DeviceName` over lockdown. Mirrors
/// `IdeviceService::connect`'s handshake (connect, pair, start a TLS session)
/// but stops before requesting a service, since we only need GetValue.
pub async fn describe_device(device: &UsbmuxdDevice) -> DeviceDescription {
    let addr = UsbmuxdAddr::from_env_var().unwrap_or_default();
    let provider = device.to_provider(addr, "lantern-ios-profiler");

    let Ok(mut lockdown) = LockdownClient::connect(&provider).await else {
        return DeviceDescription::default();
    };
    let Ok(pairing_file) = provider.get_pairing_file().await else {
        return DeviceDescription::default();
    };
    if lockdown.start_session(&pairing_file).await.is_err() {
        return DeviceDescription::default();
    }

    DeviceDescription {
        product_type: read_string(&mut lockdown, "ProductType").await,
        product_version: read_string(&mut lockdown, "ProductVersion").await,
        device_name: read_string(&mut lockdown, "DeviceName").await,
    }
}

async fn read_string(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    lockdown
        .get_value(Some(key), None)
        .await
        .ok()?
        .as_string()
        .map(str::to_string)
}

impl Connection {
    pub async fn open(udid: Option<&str>) -> Result<Self, OpenError> {
        let mut mux = UsbmuxdConnection::default().await?;
        let device = pick_device(&mux.get_devices().await?, udid).map_err(OpenError::Pick)?;
        let addr = UsbmuxdAddr::from_env_var().unwrap_or_default();
        let provider = device.to_provider(addr, "lantern-ios-profiler");

        let tunnel = match Self::open_tunnel(&provider).await {
            Ok(tunnel) => Some(tunnel),
            Err(e) => {
                // Pre-iOS 17 devices don't expose CoreDeviceProxy; fall back
                // to the lockdown instruments service lazily in remote_server.
                // This is only a warning: when the fallback works (iOS < 17)
                // nothing is wrong, and when it doesn't (iOS 17+) the service
                // call reports the real failure as an error marker.
                crate::error::warn(
                    crate::error::TUNNEL_FAILED,
                    format!("CoreDevice tunnel unavailable, trying lockdown fallback: {e:?}"),
                );
                None
            }
        };

        Ok(Self { provider, tunnel })
    }

    async fn open_tunnel(provider: &UsbmuxdProvider) -> Result<Tunnel, IdeviceError> {
        let proxy = CoreDeviceProxy::connect(provider).await?;
        let rsd_port = proxy.tunnel_info().server_rsd_port;
        let adapter = proxy.create_software_tunnel()?;
        let mut handle = AdapterHandle::new(adapter);
        let stream = handle
            .connect(rsd_port)
            .await
            .map_err(IdeviceError::Socket)?;
        let rsd = RsdHandshake::new(stream).await?;
        Ok(Tunnel { handle, rsd })
    }

    pub fn uses_core_device_tunnel(&self) -> bool {
        self.tunnel.is_some()
    }

    /// Opens a fresh instruments connection and performs the DTX capability
    /// handshake. NOTE: iOS closes concurrent dtservicehub connections, so a
    /// command should open ONE connection and multiplex channels on it.
    pub async fn remote_server(&mut self) -> Result<RemoteServer, IdeviceError> {
        let mut server = match &mut self.tunnel {
            Some(tunnel) => {
                tunnel
                    .rsd
                    .connect::<RemoteServer>(&mut tunnel.handle)
                    .await?
            }
            None => RemoteServer::connect(&self.provider).await?,
        };
        publish_capabilities(&mut server).await?;
        Ok(server)
    }
}

/// Announces our DTX capabilities on the control channel, mirroring
/// pymobiledevice3's `DTXConnection._perform_handshake`. DTXBlockCompression=0
/// is load-bearing: without it the server compresses large payloads (the
/// first sysmontap sample, typically), which the idevice message parser
/// cannot decode — the reader task dies and every channel reports
/// "remote server connection closed".
async fn publish_capabilities(server: &mut RemoteServer) -> Result<(), IdeviceError> {
    let mut capabilities = plist::Dictionary::new();
    capabilities.insert(
        "com.apple.private.DTXBlockCompression".into(),
        plist::Value::Integer(0u64.into()),
    );
    capabilities.insert(
        "com.apple.private.DTXConnection".into(),
        plist::Value::Integer(1u64.into()),
    );
    server
        .call_method(
            0,
            Some(plist::Value::String(
                "_notifyOfPublishedCapabilities:".into(),
            )),
            Some(vec![idevice::dvt::message::AuxValue::archived_value(
                plist::Value::Dictionary(capabilities),
            )]),
            false,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn usb(udid: &str, device_id: u32) -> UsbmuxdDevice {
        UsbmuxdDevice {
            connection_type: MuxConnection::Usb,
            udid: udid.into(),
            device_id,
        }
    }

    fn network(udid: &str, device_id: u32) -> UsbmuxdDevice {
        UsbmuxdDevice {
            connection_type: MuxConnection::Network(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            udid: udid.into(),
            device_id,
        }
    }

    #[test]
    fn picks_the_only_usb_device_ignoring_its_network_twin() {
        let devices = [network("A", 1), usb("A", 2)];
        assert_eq!(pick_device(&devices, None).unwrap().device_id, 2);
    }

    #[test]
    fn refuses_to_guess_between_several_usb_devices() {
        let devices = [usb("B", 1), usb("A", 2), network("A", 3)];
        assert_eq!(
            pick_device(&devices, None).unwrap_err(),
            PickError::Ambiguous(vec!["A".into(), "B".into()])
        );
    }

    #[test]
    fn reports_no_usb_device() {
        assert_eq!(pick_device(&[], None).unwrap_err(), PickError::NoDevice);
        assert_eq!(
            pick_device(&[network("A", 1)], None).unwrap_err(),
            PickError::NoDevice
        );
    }

    #[test]
    fn an_explicit_udid_picks_that_device_preferring_usb() {
        let devices = [usb("B", 1), network("A", 2), usb("A", 3)];
        assert_eq!(pick_device(&devices, Some("A")).unwrap().device_id, 3);
        // Network-only is still reachable when asked for explicitly
        assert_eq!(
            pick_device(&[network("A", 2)], Some("A"))
                .unwrap()
                .device_id,
            2
        );
    }

    #[test]
    fn an_unknown_udid_names_the_connected_devices() {
        let error = pick_device(&[usb("B", 1)], Some("A")).unwrap_err();
        assert_eq!(
            error,
            PickError::NotFound {
                udid: "A".into(),
                connected: vec!["B".into()]
            }
        );
        assert_eq!(
            error.to_string(),
            "device A is not connected (connected: B)"
        );
    }
}
