# Rust Profiler

Rust port of the former C++ profiler. This small binary is pushed to the
Android device (`/data/local/tmp/lantern-android-profiler`) and polls CPU (`/proc/<pid>/task/*/stat`),
RAM (`/proc/<pid>/statm`) and atrace (`trace_pipe`) measures for a given app.

Its stdout is NDJSON — one `{"type":"measure",...}` or `{"type":"status",...}`
object per line — and failures go to stderr as `LANTERN_PROFILER_ERROR_*` /
`LANTERN_PROFILER_WARN_*` markers. The same conventions are used by the iOS
profiler; both are parsed by `@lantern/profiler-protocol`, which documents the
line shapes in `packages/core/profiler-protocol/README.md` — keep them in sync.

Differences from the C++ version:

- `pidof` is implemented natively (scanning `/proc/*/cmdline`) instead of
  shelling out, so the binary has no runtime dependencies at all.
- Binaries are fully static musl builds linked with Rust's bundled `rust-lld`,
  so **no Android NDK (or any C toolchain) is needed** — only `rustup` targets.
- A pid change no longer leaks an extra atrace reader thread per restart.
- A thread disappearing mid-measure is skipped instead of aborting the process.

## Release

To build the device binary into the bin folder (arm64-v8a is the only
shipped ABI — real devices and the Apple Silicon emulator), run:

```sh
./build_all_abi.sh
```

## Run locally

Build for your device architecture, push and run in one go:

```sh
./run.sh [command] <arguments>
# For instance
./run.sh pollPerformanceMeasures com.example 500
```

## Tests

```sh
cargo test
```

The Linux-only parts (`prctl`, `/proc`) are gated so the unit tests also run
on a macOS host.
