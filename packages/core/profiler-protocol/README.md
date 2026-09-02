# @lantern/profiler-protocol

The wire protocol shared by the two profiler binaries, `lantern-android-profiler`
(`packages/platforms/android/rust-profiler`, runs on the device through `adb shell`) and
`lantern-ios-profiler` (`packages/platforms/ios/rust-profiler`, runs on the Mac), and the
parsers `@lantern/android` and `@lantern/ios` use to read it.

## stdout: NDJSON

One JSON object per line, flushed after every line, always with a string `type`.
`parseProfilerLine` turns a line into its object (or `undefined` for anything else, which
callers log and skip).

### `{"type":"status",...}` — lifecycle events

```json
{ "type": "status", "event": "<event>", "pid": 1234, "detail": "human readable context" }
```

`pid`, `name` and `detail` are optional. Events:

| Platform | `event`       | Meaning                                                                        |
| -------- | ------------- | ------------------------------------------------------------------------------ |
| Android  | `waiting`     | Scanning `/proc` for the app; emitted each time the wait loop starts           |
| Android  | `started`     | The app was found, `pid` is its main process; measures follow                  |
| Android  | `pid_changed` | The process vanished (`pid` is the old one); the parser resets its aggregation |
| Android  | `stalled`     | One sample took longer than the polling interval                               |
| iOS      | `started`     | Polling is set up; measures follow                                             |
| iOS      | `target`      | Attached to a process (`pid`, `name`)                                          |
| iOS      | `targetLost`  | The process went away, waiting for a relaunch                                  |
| iOS      | `stalled`     | No sysmontap sample for a while                                                |
| iOS      | `stopped`     | Clean shutdown after SIGINT                                                    |

### `{"type":"measure",...}` — samples

The measure payload differs per platform, so each package narrows it with its own guard.

Android (`isAndroidRawMeasureLine`) passes the `/proc` snapshots through verbatim; the CPU,
RAM and FPS maths happen in `@lantern/android`:

```json
{
  "type": "measure",
  "pid": "1234",
  "cpu": "1234 (com.example) S ...\n1235 (Signal Catcher) S ...",
  "ram": "4430198 96195 58113 3 0 398896 0",
  "atrace": " com.example-1234 (-----) [000] .... 1031124.476312: tracing_mark_write: E|2507\n...",
  "timestamp": 1700000000000,
  "timings": { "totalMs": 12, "cpuMs": 5, "ramMs": 1, "atraceMs": 6 }
}
```

- `cpu`: the `/proc/<pid>/task/*/stat` lines, one per thread, `\n`-joined.
- `ram`: the `/proc/<pid>/statm` lines, one per pid.
- `atrace`: the `trace_pipe` lines gathered since the previous sample, empty when the app was
  idle or atrace is unavailable.
- `timestamp`: epoch milliseconds; `timings`: how long the sample took, per section.

iOS already carries a computed `Measure` (see `@lantern/types`):

```json
{
  "type": "measure",
  "time": 1700000000000,
  "cpu": { "perName": { "Total": 25.5 }, "perCore": {} },
  "ram": 123.4,
  "fps": 59.9,
  "threadCount": 17,
  "pid": 1234
}
```

## stderr: markers

```
LANTERN_PROFILER_ERROR_<CODE>: message
LANTERN_PROFILER_WARN_<CODE>: message
```

`ERROR` markers are fatal — the command exits non-zero right after. `WARN` markers are
notices the run survives. Anything else on stderr is free-form diagnostics.
`parseMarkerLine` splits a line into `{ level, code, message }`; `lastErrorMessage` extracts
the message of the last error marker from a captured stderr (the last one is what ended the
command, earlier ones are context).

| Platform | Marker                                                                                                | Meaning                                                           |
| -------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Android  | `WARN_CANNOT_OPEN_FILE`                                                                               | A thread's `stat` vanished mid-sample (expected, logged at debug) |
| Android  | `WARN_ATRACE_UNAVAILABLE`                                                                             | No `trace_pipe`: FPS stays empty, CPU/RAM go on                   |
| Android  | `ERROR_USAGE`                                                                                         | Bad arguments                                                     |
| Android  | `ERROR_PID_CLOSED`                                                                                    | `printPerformanceMeasure`: the pid is gone                        |
| iOS      | `WARN_TUNNEL_FAILED`                                                                                  | CoreDevice tunnel unavailable, lockdown fallback attempted        |
| iOS      | `ERROR_NO_DEVICE`, `ERROR_SERVICE_FAILED`, `ERROR_APP_NOT_FOUND`, `ERROR_STREAM_ENDED`, `ERROR_USAGE` | See `rust-profiler/README.md`                                     |
