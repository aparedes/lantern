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

- `lantern summarize`: print the key numbers of one or more results files —
  score, CPU, FPS, RAM, high CPU time and busiest threads, with their spread
  across iterations. The numbers are the ones the HTML report shows.

  ```bash
  lantern summarize results.json
  lantern summarize results-folder --json
  ```

- `lantern doctor`: check that this host and the connected devices are ready
  to profile (adb, Android API level and ABI, the iOS profiler binary, iOS
  devices). Every problem comes with a fix; exits with 3 when no device can be
  profiled.

  ```bash
  lantern doctor
  ```

- `lantern tools list_devices` / `lantern tools list_apps`: list the connected
  devices of both platforms, or the apps installed on the selected device.

  ```bash
  lantern tools list_devices --json
  lantern tools list_apps --platform ios
  ```

- `lantern tools get_bundle_id`: retrieve the bundle id of the app currently
  running on the device.

  ```bash
  lantern tools get_bundle_id --platform ios
  ```

Run `lantern --help` (or `lantern <command> --help`) for the full CLI
reference.

## Scripting and agents

Every command follows the same output contract, so that scripts, CI jobs and
AI agents can drive Lantern without parsing human-readable text:

- **stdout carries only the command's result.** Logs, and the output of the
  commands `lantern test` runs (`--testCommand`, `--beforeEachCommand`...), go
  to stderr.
- **`--json`** (on `test`, `summarize`, `report`, `doctor` and the `tools`
  commands) prints the result as a single JSON object on stdout, e.g.
  `{"bundleId":"com.example.app"}`, `{"htmlPath":"/tmp/report.html"}` or
  `{"status":"SUCCESS","resultsPath":"results.json","summary":{…}}`. A failure
  prints `{"error":{"code":"NO_DEVICE","message":"…","details":{…}}}` instead.
- **Read summaries, not results files.** A results file holds every sample
  (hundreds of KB); `lantern summarize --json` (and the `summary` of
  `lantern test --json`) is about 1 KB, carries a `schemaVersion`, and lists
  `caveats` worth knowing when reading the numbers (no refresh rate recorded,
  failed iterations, iOS has no per-thread data...). Its shape is
  `ResultSummary` in
  [`packages/core/reporter/src/reporting/summary.ts`](./packages/core/reporter/src/reporting/summary.ts).
- Results files now also record the `platform`, the `device` and its refresh
  rate (`specs.refreshRate`), which FPS is scored against (60 Hz is assumed
  for older files).
- **Exit codes** tell failures apart:

  | Code          | Meaning                                                                                    |
  | ------------- | ------------------------------------------------------------------------------------------ |
  | 0             | Success                                                                                    |
  | 1             | The run failed (test command failed, app crashed, profiler gave up...) or unexpected error |
  | 2             | Invalid usage: unknown option, missing argument, missing results file                      |
  | 3             | Device or app setup: no / several / unknown device, unsupported device, app not running    |
  | 4             | A requested threshold was not met                                                          |
  | 130, 131, 143 | Interrupted by SIGINT, SIGQUIT, SIGTERM                                                    |

  The error `code`s are listed in
  [`packages/core/profiler-protocol/src/errors.ts`](./packages/core/profiler-protocol/src/errors.ts).

- `lantern report` does not open a browser with `--no-open`, when stdout is
  not a terminal, or when `CI` is set.

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

produces `build/standalone/lantern-macos-arm64`, a self-contained
executable you can copy anywhere on your PATH.

There is no hosted installer — build from source or produce the standalone
binary yourself.

## How it works

Android is profiled by a small Rust binary pushed to the device, reading
`/proc` and atrace — see
[`packages/platforms/android/rust-profiler/README.md`](./packages/platforms/android/rust-profiler/README.md).
iOS is profiled by a host-side Rust binary that talks to the device over
usbmuxd and the instruments services — see
[`packages/platforms/ios/rust-profiler/README.md`](./packages/platforms/ios/rust-profiler/README.md).
The performance score is computed from CPU, FPS and thread-lock; iOS has no
per-thread data, so its score has no thread-lock penalty.

## Environment variables

| Variable                     | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `PLATFORM`                   | `android` or `ios`, used when `--platform` isn't passed |
| `LANTERN_BINARY_PATH`        | Override the Android profiler binary                    |
| `LANTERN_IOS_BINARY_PATH`    | Override the iOS profiler binary                        |
| `LANTERN_IOS_DEBUG`          | Verbose iOS profiler protocol logs on stderr            |
| `LANTERN_IOS_REFRESH_RATE`   | Override the auto-detected iOS display refresh rate     |
| `LANTERN_WEBAPP_PATH`        | Override the bundled `measure` web app path             |
| `LANTERN_REPORT_ASSETS_PATH` | Override the bundled `report` web app path              |
| `LANTERN_CODESIGN_IDENTITY`  | Default signing identity for `build:standalone --sign`  |

## Contributing

We love pull requests! Head over to [the contribution guide](./CONTRIBUTING.md)
to get started.

## Credits

Lantern started as a fork of [Flashlight](https://github.com/bamlab/flashlight) by BAM (MIT); the Android profiler, the report UI and the measure workflow trace back to that project. Thank you to its authors.
