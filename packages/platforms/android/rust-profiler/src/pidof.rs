use std::fs;

/// Does a `/proc/<pid>/cmdline` belong to `bundle_id`?
///
/// Matches like `pidof`: against argv[0] and against its basename. Android
/// app processes have their package name (e.g. `com.example`) as argv[0],
/// while the self-profiling mode looks up the profiler binary itself, whose
/// argv[0] is a path like `/data/local/tmp/lantern-android-profiler`.
fn matches_bundle_id(cmdline: &[u8], bundle_id: &str) -> bool {
    let argv0 = cmdline.split(|&b| b == 0).next().unwrap_or(&[]);
    if argv0.is_empty() {
        return false;
    }
    let basename = argv0.rsplit(|&b| b == b'/').next().unwrap_or(argv0);

    argv0 == bundle_id.as_bytes() || basename == bundle_id.as_bytes()
}

/// Native replacement for `popen("pidof <bundleId>")`: scan /proc directly.
/// Returns pids in ascending order, so the app's main process comes first.
pub fn pid_of(bundle_id: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };

    let mut pids: Vec<u64> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u64>().ok())
        .filter(|pid| {
            fs::read(format!("/proc/{pid}/cmdline"))
                .map(|cmdline| matches_bundle_id(&cmdline, bundle_id))
                .unwrap_or(false)
        })
        .collect();

    pids.sort_unstable();
    pids.iter().map(|pid| pid.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_android_app_process_name() {
        assert!(matches_bundle_id(b"com.example\0", "com.example"));
        assert!(matches_bundle_id(b"com.example", "com.example"));
        assert!(!matches_bundle_id(b"com.example:remote\0", "com.example"));
        assert!(!matches_bundle_id(b"com.example.other\0", "com.example"));
    }

    #[test]
    fn matches_binary_by_basename_for_self_profiling() {
        assert!(matches_bundle_id(
            b"/data/local/tmp/lantern-android-profiler\0pollPerformanceMeasures\0",
            "lantern-android-profiler"
        ));
        // The self-profiling copy must NOT match itself
        assert!(!matches_bundle_id(
            b"/data/local/tmp/lantern-android-profiler_SELF_REPORT\0",
            "lantern-android-profiler"
        ));
    }

    #[test]
    fn ignores_kernel_threads_with_empty_cmdline() {
        assert!(!matches_bundle_id(b"", "com.example"));
        assert!(!matches_bundle_id(b"\0", "com.example"));
    }

    // /proc only exists on Linux; the crate is also unit-tested on macOS hosts
    #[cfg(target_os = "linux")]
    #[test]
    fn finds_own_process() {
        let exe = std::fs::read_link("/proc/self/exe").unwrap();
        let name = exe.file_name().unwrap().to_str().unwrap();
        let my_pid = std::process::id().to_string();
        assert!(pid_of(name).contains(&my_pid));
    }
}
