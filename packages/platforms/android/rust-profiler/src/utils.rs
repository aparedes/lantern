use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch milliseconds, the `timestamp` of a measure line.
pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append the whole content of a file, followed by a newline, to `buffer`.
///
/// On failure, emit the `LANTERN_PROFILER_WARN_CANNOT_OPEN_FILE` marker on
/// stderr: the TypeScript side logs it at debug level, a thread dying
/// mid-measure is expected.
pub fn append_file(buffer: &mut Vec<u8>, path: &str) {
    match std::fs::read(path) {
        Ok(content) => {
            buffer.extend_from_slice(&content);
            buffer.push(b'\n');
        }
        Err(_) => {
            crate::wire::warn("CANNOT_OPEN_FILE", path);
        }
    }
}

/// Bytes gathered by `append_file` → the string payload of a measure line,
/// with the trailing newline trimmed so a `split("\n")` on the other side
/// does not yield an empty last entry.
pub fn to_payload(mut bytes: Vec<u8>) -> String {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Flush `out`, exiting quietly when the reader is gone.
///
/// Rust ignores SIGPIPE, so once `adb shell` (and the TypeScript side behind
/// it) has gone away every write fails with `BrokenPipe` instead of killing
/// us — and the poll loop would keep scanning /proc on the device forever.
/// Any other flush error is ignored, as before.
pub fn flush_or_exit(out: &mut impl Write) {
    if let Err(error) = out.flush() {
        if error.kind() == io::ErrorKind::BrokenPipe {
            std::process::exit(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_payload_trims_exactly_one_trailing_newline() {
        assert_eq!(to_payload(b"a\nb\n".to_vec()), "a\nb");
        assert_eq!(to_payload(b"a\nb".to_vec()), "a\nb");
        assert_eq!(to_payload(Vec::new()), "");
        // Only the separator we add ourselves, not an intentionally empty line
        assert_eq!(to_payload(b"a\n\n".to_vec()), "a\n");
    }
}
