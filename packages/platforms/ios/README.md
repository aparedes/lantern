# Measure the performance of any iOS app

Implementation of the Lantern `Profiler` for real iOS devices.

It spawns the bundled Rust binary (`rust-profiler/`,
`lantern-ios-profiler`) which talks to the device over usbmuxd and the
instruments services — the CoreDevice tunnel on iOS 17+ (including iOS 26),
or the legacy lockdown service before that — and streams CPU, RAM and FPS as
NDJSON. No Python, idb, sudo, or external tunnel daemon required.

## Requirements

- macOS host with the device connected over USB
- Developer Mode enabled on the device
- The personalized Developer Disk Image mounted (opening the device once in
  Xcode, or `devicectl`, or `pymobiledevice3 mounter auto-mount` all do this)
- The profiler binary: the Apple Silicon build is committed as
  `rust-profiler/bin/lantern-ios-profiler` and embedded in the standalone
  CLI, like the Android profiler. Rebuild it with
  `rust-profiler/build_macos.sh` after changing the crate (or set
  `LANTERN_IOS_BINARY_PATH` to a binary you built elsewhere)

## Usage

```bash
lantern measure --platform ios
# or from source:
PLATFORM=ios bun packages/commands/measure/dist/server/bin.js measure
```

`--platform` is optional: when only one kind of device is connected (an iOS
device over USB, or an Android device visible to `adb`), Lantern auto-detects
the platform. Pass the flag (or set `PLATFORM`) when both are plugged in.

See `rust-profiler/README.md` for the binary's CLI and wire protocol.

## Architecture

- The Rust binary discovers the device over usbmuxd and connects via the
  CoreDevice tunnel on iOS 17+ (including iOS 26), falling back to the
  legacy lockdown `remoteserver` service before that. No sudo or external
  tunnel daemon: the tunnel runs in-process.
- **One instruments (`dtservicehub`) connection is used for everything.**
  Opening multiple concurrent connections gets them closed by the device
  ("remote server connection closed"), so `sysmontap` (CPU/RAM) and
  `graphics.opengl` (FPS) are multiplexed as separate DTX channels over that
  single connection.
- `poll.rs` lets `sysmontap` drive emission — one measure per sample —
  draining any queued graphics frames first so FPS stays fresh; FPS is
  omitted until the first frame arrives (the report draws those samples as
  gaps rather than hiding the FPS chart). The target process is matched by
  executable name every sample, so it survives app restarts (`targetLost`
  / `target` transitions).
- See `rust-profiler/README.md`'s "Wire protocol" section for the exact
  NDJSON shape emitted on stdout.

## Validation status

Validated end to end on a real iOS 26 device on 2026-08-30: CoreDevice
tunnel bring-up, `sysmontap` rows and measure emission, CPU scale (already a
percentage of one core, no `×100` needed), `graphics.opengl` FPS, and
app-listing keys (`CFBundleIdentifier`, `ExecutableName`, `DisplayName`,
`BundlePath`, `Type`, `Restricted`, `Placeholder`).

Remaining: long-run stability (extended polling, app kill/relaunch mid-run,
Mac-side CPU overhead), and confirming ProMotion (120 Hz) devices against
the model-based refresh-rate lookup — `hardwareInformation` carries only CPU
keys and no display data, so refresh rate can't be read from the device
directly.

## Known gaps

- No per-thread CPU (`sysmontap` doesn't provide it) and no per-core data.
- No screen recording.
- `detectCurrentBundleId` uses a `running-apps` heuristic: it returns the
  bundle id when exactly one user app is running, and otherwise asks the
  user to pick one — iOS has no "focused app" API outside Instruments.
- Refresh rate is derived from a `ProductType` → model lookup
  (`isProMotionModel` in `src/index.ts`), defaulting to 60 Hz;
  `LANTERN_IOS_REFRESH_RATE` overrides it for models the table gets wrong.
