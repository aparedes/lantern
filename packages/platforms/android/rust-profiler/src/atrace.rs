use std::fs::File;
use std::io::{BufRead, BufReader};
use std::sync::Mutex;

/// Lines read from the atrace pipe by the reader thread, drained by the
/// main thread on every measure.
static ATRACE_LINES: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

/// Run from the atrace reader thread.
fn add_atrace_line(line: Vec<u8>) {
    ATRACE_LINES.lock().unwrap().push(line);
}

/// Run from the main thread: take the buffered lines, joined by newlines.
pub fn take_atrace_lines() -> Vec<u8> {
    let mut lines = ATRACE_LINES.lock().unwrap();
    let mut joined = Vec::new();
    for line in lines.iter() {
        joined.extend_from_slice(line);
        joined.push(b'\n');
    }
    lines.clear();
    joined
}

/// Run from the main thread while waiting for the app to start.
pub fn clear_atrace_lines() {
    ATRACE_LINES.lock().unwrap().clear();
}

fn open_trace_stream() -> Option<File> {
    // Second path is an alternative location on certain devices
    let paths = [
        "/sys/kernel/debug/tracing/trace_pipe",
        "/sys/kernel/tracing/trace_pipe",
    ];

    paths.iter().find_map(|path| File::open(path).ok())
}

/// Body of the atrace reader thread: block on the trace pipe and buffer
/// every line. `trace_pipe` is a stream, so reads block until data arrives.
///
/// When no trace pipe can be opened (atrace unavailable on this OS build, or
/// not readable from adb shell) the thread emits the
/// `LANTERN_PROFILER_WARN_ATRACE_UNAVAILABLE` marker on stderr and returns:
/// the main thread keeps polling CPU/RAM, its atrace payload simply stays empty.
pub fn read_atrace_thread() {
    let Some(file) = open_trace_stream() else {
        crate::wire::warn("ATRACE_UNAVAILABLE", "Unable to find Atrace output file");
        return;
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();

    loop {
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                // Hand the buffer over instead of copying it; the next read
                // starts from a fresh (empty) Vec
                add_atrace_line(std::mem::take(&mut line));
            }
        }
    }
}
