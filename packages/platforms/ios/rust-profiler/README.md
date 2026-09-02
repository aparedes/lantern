# lantern-ios-profiler

Host-side Rust profiler for real iOS devices, built on the
[`idevice`](https://github.com/jkcoxson/idevice) crate. It replaces the
py-ios-device (`pyidevice`) dependency: a single static binary, no Python, no
idb, no sudo, no external tunnel daemon.

## How it connects

- **iOS 17+ (incl. iOS 26):** usbmuxd → lockdown → `CoreDeviceProxy` →
  CDTunnel handshake → userspace TCP stack (`jktcp`) over the tunnel's raw
  IPv6 packets → RSD handshake → `com.apple.instruments.dtservicehub`.
  Everything runs in-process and unprivileged.
- **iOS < 17:** falls back to the lockdown
  `com.apple.instruments.remoteserver` service automatically.

The personalized Developer Disk Image must be mounted (Xcode, `devicectl`, or
`pymobiledevice3 mounter auto-mount` all do this). If instruments services are
missing from RSD, that is the first thing to check. Developer Mode must be
enabled on the device.

## Commands

```
lantern-ios-profiler devices
lantern-ios-profiler apps         [--udid <udid>] [--raw]
lantern-ios-profiler running-apps [--udid <udid>]
lantern-ios-profiler info    [--udid <udid>]
lantern-ios-profiler launch  --bundle-id <id> [--udid <udid>]
lantern-ios-profiler kill    --bundle-id <id> | --pid <n> [--udid <udid>]
lantern-ios-profiler poll    --bundle-id <id> [--interval-ms <n=500>] [--udid <udid>]

Without `--udid`, exactly one USB device must be connected: with several the
command fails with `AMBIGUOUS_DEVICE` and lists their udids (network entries
duplicate USB ones and are ignored for that choice). `@lantern/ios` applies
the same rule and passes `--udid` explicitly.
```

Set `LANTERN_IOS_DEBUG=1` for verbose protocol logs on stderr (or a
`tracing` filter string such as `idevice=trace` for finer control).

## Device and app listings (JSON)

`devices` prints one object per usbmuxd entry. The three lockdown-sourced
fields are best effort and are `null` when the device is not paired or
lockdown is unreachable — the device is still listed either way:

```json
[{"udid":"00008120-...","deviceId":7,"connectionType":"Usb","productType":"iPhone16,1","productVersion":"26.0","deviceName":"Test iPhone"}]
```

`apps` prints the installed apps worth measuring — the listing's `Type` is
`User` (third-party) or `Unknown` (Apple's own App Store apps such as Pages
or TestFlight). `PluginKit` extensions and system apps are filtered out, and
the array is sorted case-insensitively by `name`. `executableName` is `null`
when the listing carries no executable name or path:

```json
[{"bundleId":"com.example.app","name":"Example","executableName":"Example","kind":"User"}]
```

`--raw` bypasses the filtering and dumps every listing entry verbatim, which
is the shape to inspect when a device reports unfamiliar keys.

`running-apps` is `apps` intersected with the device's process list: the same
objects plus the `pid` of the matching process (matched by executable name,
requiring the device's own `isApplication` flag). Apps that are installed but
not running are omitted:

```json
[{"bundleId":"com.example.app","name":"Example","executableName":"Example","kind":"User","pid":1234}]
```

## Wire protocol (`poll`)

One JSON object per stdout line (NDJSON):

```json
{"type":"status","event":"started","detail":"polling com.example.app every 500ms (tunnel: CoreDevice)"}
{"type":"status","event":"target","pid":1234,"name":"MyApp"}
{"type":"measure","time":1700000000000,"cpu":{"perName":{"Total":25.5},"perCore":{}},"ram":123.4,"fps":59.9,"threadCount":17,"pid":1234}
{"type":"status","event":"targetLost"}
{"type":"status","event":"stopped"}
```

- `measure` matches the `Measure` type in `@lantern/types`: `time` is
  epoch ms, `cpu.perName.Total` is percent of one core (can exceed 100 on
  multiple cores), `ram` is MB (phys footprint), `fps` is CoreAnimation FPS
  and is omitted until the first graphics sample arrives, and again whenever
  the last graphics sample is older than `max(3 × interval, 2 s)` — graphics
  pushes come about once a second on the device's own cadence and stop while
  the app is idle or backgrounded.
- CPU comes from the DVT `sysmontap` service (whole-process only — per-thread
  CPU is not available from sysmontap), FPS from the DVT `graphics.opengl`
  service. Both are channels multiplexed over one instruments connection
  (iOS 26 closes concurrent `dtservicehub` connections).
- The target process is matched by executable name (resolved via the
  application-listing service) falling back to the bundle id and its last
  component, every sample — so an app relaunch (new pid) re-attaches
  automatically and emits `targetLost`/`target` transitions.
- Errors are marked on stderr as `LANTERN_PROFILER_ERROR_<CODE>: message`
  (`NO_DEVICE`, `AMBIGUOUS_DEVICE`, `SERVICE_FAILED`, `APP_NOT_FOUND`, `STREAM_ENDED`, `USAGE`),
  the same convention as the Android profiler (parsed by `@lantern/profiler-protocol`). Non-fatal
  notices use `LANTERN_PROFILER_WARN_<CODE>: message` — currently
  `TUNNEL_FAILED`, emitted when the CoreDevice tunnel is unavailable and the
  lockdown fallback is attempted (normal on iOS < 17).
- When no sysmontap sample arrives for a while, a
  `{"type":"status","event":"stalled"}` line is emitted (after ~12 s at the
  default interval); after ~40 s of silence the process exits with
  `STREAM_ENDED`. `--interval-ms` below 100 is rejected.
- SIGINT/SIGTERM stop both taps cleanly and end with a `stopped` status.

## Building

On macOS (the only platform that can reach a device over usbmuxd out of the
box):

```
./build_macos.sh   # builds the arm64 release binary into bin/
```

Only Apple Silicon is built: Apple has retired Intel Macs from macOS support and
the project has no Intel machine to build or test on. The binary in `bin/`
(`lantern-ios-profiler`) is committed, mirroring the Android profiler:
`@lantern/ios` resolves it from a source checkout and `bun run build:standalone`
embeds it. Commit the rebuilt binary together with the crate change that
motivated it.

CI runs `cargo fmt/clippy/test` and `build_macos.sh` on a macOS runner; the
crate also compiles and unit-tests on Linux.

## Validation status

Written against idevice 0.1.65 (pinned). Validated end to end on a real iOS 26
device on 2026-08-30 (tunnel, sysmontap, graphics FPS, CPU scale). See
`../README.md`'s "Validation status" and "Known gaps" sections for the
remaining checks and deliberate limitations.
