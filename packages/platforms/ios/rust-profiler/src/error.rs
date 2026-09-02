use std::fmt::Display;

// Shared with the Android profiler (see @lantern/profiler-protocol): machine-matchable
// markers on stderr that the TypeScript side surfaces to the user.
pub const NO_DEVICE: &str = "NO_DEVICE";
pub const TUNNEL_FAILED: &str = "TUNNEL_FAILED";
pub const SERVICE_FAILED: &str = "SERVICE_FAILED";
pub const APP_NOT_FOUND: &str = "APP_NOT_FOUND";
pub const STREAM_ENDED: &str = "STREAM_ENDED";
pub const USAGE: &str = "USAGE";

pub fn report(code: &str, msg: impl Display) {
    eprintln!("LANTERN_PROFILER_ERROR_{code}: {msg}");
}

/// Non-fatal notice (e.g. a fallback path was taken). Distinct prefix so the
/// TypeScript side can log it at warn level and never mistake it for the
/// failure that ends a command.
pub fn warn(code: &str, msg: impl Display) {
    eprintln!("LANTERN_PROFILER_WARN_{code}: {msg}");
}

pub fn fail(code: &str, msg: impl Display) -> ! {
    report(code, msg);
    std::process::exit(1);
}
