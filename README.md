# Lantern 🏮

Lantern measures the performance of any Android or iOS app — CPU, RAM, FPS —
from the outside, with no code changes to your app and no restrictions on
measuring production builds. It produces a live web dashboard while you use
the app, plus shareable HTML reports for automated test runs.

## Commands

- `lantern measure`: live web dashboard with real-time measures.

  ```bash
  lantern measure --platform ios
  ```

  `--platform android|ios` is optional — it's auto-detected when only one
  kind of device is connected.

- `lantern test`: automate your measures with e2e performance testing,
  averaged over several iterations, written out as JSON results.

  ```bash
  lantern test --bundleId com.example.app --testCommand "maestro test flow.yml" --platform ios
  ```

- `lantern report`: generate a static HTML report from one or more results
  files.

  ```bash
  lantern report results1.json results2.json -o output-dir
  ```

- `lantern tools get_bundle_id`: retrieve the bundle id of the app currently
  running on the device.

  ```bash
  lantern tools get_bundle_id --platform ios
  ```

Run `lantern --help` (or `lantern <command> --help`) for the full CLI
reference.

## Requirements

- A macOS host — the standalone binary and the iOS profiler are macOS-only.
- Android: `adb` on your PATH, and a device with USB debugging enabled
  (API 24+).
- iOS: a device connected over USB, with Developer Mode enabled and the
  personalized Developer Disk Image mounted once via Xcode or `devicectl`.
  See [`packages/platforms/ios/README.md`](./packages/platforms/ios/README.md)
  for details.

## Installation

**From source**

```bash
bun install
bun run build
bun run lantern -- measure
```

**Standalone macOS binary**

```bash
bun run build:standalone
```

produces `build/standalone/lantern`, a self-contained
executable you can copy anywhere on your PATH.

Signed and notarized builds for Apple Silicon Macs are attached to
[GitHub Releases](https://github.com/aparedes/lantern/releases): download
`lantern.zip`, unzip it and move `lantern` onto your PATH.

## How it works

Android is profiled by a small Rust binary pushed to the device, reading
`/proc` and atrace — see
[`packages/platforms/android/rust-profiler/README.md`](./packages/platforms/android/rust-profiler/README.md).
iOS is profiled by a host-side Rust binary that talks to the device over
usbmuxd and the instruments services — see
[`packages/platforms/ios/rust-profiler/README.md`](./packages/platforms/ios/rust-profiler/README.md).
The performance score is computed from CPU, FPS and thread-lock; iOS has no
per-thread data, so its score has no thread-lock penalty. FPS is scored against
the device's refresh rate, which `lantern test` and `lantern measure` record in
the result (`specs`); result files without it are scored against 60 Hz. On
Android, idle time counts as on-target frames; on iOS, samples without
rendering carry no FPS.

## Environment variables

| Variable                     | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `PLATFORM`                   | `android` or `ios`, used when `--platform` isn't passed      |
| `LANTERN_BINARY_PATH`        | Override the Android profiler binary                         |
| `LANTERN_IOS_BINARY_PATH`    | Override the iOS profiler binary                             |
| `LANTERN_IOS_DEBUG`          | Verbose iOS profiler protocol logs on stderr                 |
| `LANTERN_IOS_REFRESH_RATE`   | Override the auto-detected iOS display refresh rate          |
| `LANTERN_WEBAPP_PATH`        | Override the bundled `measure` web app path                  |
| `LANTERN_REPORT_ASSETS_PATH` | Override the bundled `report` web app path                   |
| `LANTERN_CODESIGN_IDENTITY`  | Default signing identity for `build:standalone --sign`       |
| `LANTERN_NOTARY_PROFILE`     | Default notarytool profile for `build:standalone --notarize` |

## Contributing

We love pull requests! Head over to [the contribution guide](./CONTRIBUTING.md)
to get started.

## Credits

Lantern started as a fork of [Flashlight](https://github.com/bamlab/flashlight) by BAM (MIT); the Android profiler, the report UI and the measure workflow trace back to that project. Thank you to its authors.
