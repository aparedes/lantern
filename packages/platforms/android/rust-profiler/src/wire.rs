//! NDJSON wire protocol written to stdout, shared in shape with the iOS
//! profiler and parsed by `@lantern/profiler-protocol` on the TypeScript
//! side (see packages/core/profiler-protocol/README.md).
//!
//! One JSON object per line. `{"type":"measure",...}` lines carry the raw
//! /proc snapshots (the TypeScript side does the CPU/RAM/FPS maths),
//! `{"type":"status",...}` lines carry lifecycle events. Failures go to
//! stderr as `LANTERN_PROFILER_ERROR_<CODE>: message` and non-fatal notices
//! as `LANTERN_PROFILER_WARN_<CODE>: message`.

use std::fmt::Display;
use std::io::Write;

use serde::Serialize;

use crate::utils::flush_or_exit;

/// Raw measure: the file contents are passed through verbatim (trailing
/// newline trimmed) so the TypeScript parsers keep their input unchanged.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename = "measure")]
pub struct MeasureLine {
    /// The app's main pid, as a string: it is compared against `/proc` stat
    /// columns and atrace `-<pid> ` markers, never used as a number.
    pub pid: String,
    /// `/proc/<pid>/task/*/stat` lines, one per thread.
    pub cpu: String,
    /// `/proc/<pid>/statm` lines, one per pid.
    pub ram: String,
    /// atrace `trace_pipe` lines gathered since the previous measure; empty
    /// when atrace is unavailable or the app was idle.
    pub atrace: String,
    /// Epoch milliseconds when the sample was taken.
    pub timestamp: u128,
    pub timings: Timings,
}

/// How long the sample took, for diagnosing a device that cannot keep up
/// with the polling interval.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct Timings {
    #[serde(rename = "totalMs")]
    pub total_ms: u128,
    #[serde(rename = "cpuMs")]
    pub cpu_ms: u128,
    #[serde(rename = "ramMs")]
    pub ram_ms: u128,
    #[serde(rename = "atraceMs")]
    pub atrace_ms: u128,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename = "status")]
pub struct StatusLine {
    pub event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl StatusLine {
    pub fn waiting(bundle_id: &str) -> Self {
        Self {
            event: "waiting",
            pid: None,
            detail: Some(format!("waiting for {bundle_id} to start")),
        }
    }

    pub fn started(pid: u64) -> Self {
        Self {
            event: "started",
            pid: Some(pid),
            detail: None,
        }
    }

    pub fn pid_changed(pid: u64, detail: String) -> Self {
        Self {
            event: "pid_changed",
            pid: Some(pid),
            detail: Some(detail),
        }
    }

    pub fn stalled(took_ms: u128, interval_ms: u128) -> Self {
        Self {
            event: "stalled",
            pid: None,
            detail: Some(format!(
                "measure took {took_ms}ms, more than the {interval_ms}ms interval"
            )),
        }
    }
}

/// Write one line and flush it: the TypeScript side reads line by line and
/// must not wait on a buffered half-line. Exits quietly when the reader is
/// gone (see `flush_or_exit`).
pub fn emit(out: &mut impl Write, line: &impl Serialize) {
    // stdout is the wire; a serialization failure here is a programming error.
    let json = serde_json::to_string(line).expect("serialize NDJSON line");
    let _ = out.write_all(json.as_bytes());
    let _ = out.write_all(b"\n");
    flush_or_exit(out);
}

pub fn error(code: &str, msg: impl Display) {
    eprintln!("LANTERN_PROFILER_ERROR_{code}: {msg}");
}

pub fn warn(code: &str, msg: impl Display) {
    eprintln!("LANTERN_PROFILER_WARN_{code}: {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_line_matches_the_typescript_guard_shape() {
        let line = MeasureLine {
            pid: "1234".into(),
            cpu: "1234 (com.example) S 1 2\n1235 (Signal Catcher) S 1 2".into(),
            ram: "4430198 96195 58113 3 0 398896 0".into(),
            atrace: String::new(),
            timestamp: 1_700_000_000_000,
            timings: Timings {
                total_ms: 12,
                cpu_ms: 5,
                ram_ms: 1,
                atrace_ms: 6,
            },
        };
        let json = serde_json::to_value(&line).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "measure",
                "pid": "1234",
                "cpu": "1234 (com.example) S 1 2\n1235 (Signal Catcher) S 1 2",
                "ram": "4430198 96195 58113 3 0 398896 0",
                "atrace": "",
                "timestamp": 1_700_000_000_000u64,
                "timings": { "totalMs": 12, "cpuMs": 5, "ramMs": 1, "atraceMs": 6 },
            })
        );
    }

    #[test]
    fn payloads_with_quotes_and_newlines_round_trip() {
        // Thread names come straight from /proc and can contain anything
        let cpu = "1 (weird \"name\"\\slash) S\nline two\r\nline three";
        let line = MeasureLine {
            pid: "1".into(),
            cpu: cpu.into(),
            ram: String::new(),
            atrace: " com.example-1 [000] 1.5: tracing_mark_write: B|1|Choreographer#doFrame"
                .into(),
            timestamp: 0,
            timings: Timings::default(),
        };
        let json = serde_json::to_string(&line).unwrap();
        assert!(!json.contains('\n'), "one line per object: {json}");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["cpu"], cpu);
        assert_eq!(parsed["atrace"], line.atrace);
    }

    #[test]
    fn status_lines_omit_empty_fields() {
        assert_eq!(
            serde_json::to_string(&StatusLine::started(42)).unwrap(),
            r#"{"type":"status","event":"started","pid":42}"#
        );
        assert_eq!(
            serde_json::to_string(&StatusLine::waiting("com.example")).unwrap(),
            r#"{"type":"status","event":"waiting","detail":"waiting for com.example to start"}"#
        );
        assert_eq!(
            serde_json::to_string(&StatusLine::pid_changed(
                42,
                "Directory does not exist: /proc/42/task".into()
            ))
            .unwrap(),
            r#"{"type":"status","event":"pid_changed","pid":42,"detail":"Directory does not exist: /proc/42/task"}"#
        );
        assert_eq!(
            serde_json::to_string(&StatusLine::stalled(750, 500)).unwrap(),
            r#"{"type":"status","event":"stalled","detail":"measure took 750ms, more than the 500ms interval"}"#
        );
    }

    #[test]
    fn emit_writes_one_terminated_line() {
        let mut out = Vec::new();
        emit(&mut out, &StatusLine::started(7));
        assert_eq!(
            out,
            b"{\"type\":\"status\",\"event\":\"started\",\"pid\":7}\n"
        );
    }
}
