mod atrace;
mod pidof;
mod utils;
mod wire;

use std::fmt;
use std::io::{BufWriter, Write};
use std::time::{Duration, Instant};

use atrace::{clear_atrace_lines, read_atrace_thread, take_atrace_lines};
use pidof::pid_of;
use utils::{append_file, now_ms, to_payload};
use wire::{emit, MeasureLine, StatusLine, Timings};

/// The app's /proc/<pid>/task directory disappeared: the process is gone.
struct PidClosedError(String);

impl fmt::Display for PidClosedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Directory does not exist: {}", self.0)
    }
}

fn read_cpu_stats(pids: &[String]) -> Result<Vec<u8>, PidClosedError> {
    let mut buffer = Vec::new();
    for pid in pids {
        let path = format!("/proc/{pid}/task");

        let entries = std::fs::read_dir(&path).map_err(|_| PidClosedError(path.clone()))?;

        for entry in entries.flatten() {
            let sub_process_path = entry.path().join("stat");
            append_file(&mut buffer, &sub_process_path.to_string_lossy());
        }
    }
    Ok(buffer)
}

fn read_memory_stats(pids: &[String]) -> Vec<u8> {
    let mut buffer = Vec::new();
    for pid in pids {
        append_file(&mut buffer, &format!("/proc/{pid}/statm"));
    }
    buffer
}

/// Take one sample and emit it as a `measure` line. The first pid is the
/// app's main process.
fn print_performance_measure(
    out: &mut impl Write,
    pids: &[String],
) -> Result<u128, PidClosedError> {
    let start = Instant::now();

    let cpu = read_cpu_stats(pids)?;
    let cpu_end = start.elapsed();
    let ram = read_memory_stats(pids);
    let memory_end = start.elapsed();
    // Empty when atrace is unavailable (see atrace::read_atrace_thread)
    let atrace = take_atrace_lines();
    let atrace_end = start.elapsed();

    let timestamp = now_ms();
    let total = start.elapsed();

    emit(
        out,
        &MeasureLine {
            pid: pids[0].clone(),
            cpu: to_payload(cpu),
            ram: to_payload(ram),
            atrace: to_payload(atrace),
            timestamp,
            timings: Timings {
                total_ms: total.as_millis(),
                cpu_ms: cpu_end.as_millis(),
                ram_ms: (memory_end - cpu_end).as_millis(),
                atrace_ms: (atrace_end - memory_end).as_millis(),
            },
        },
    );

    Ok(total.as_millis())
}

fn main_pid(pids: &[String]) -> u64 {
    pids.first().and_then(|pid| pid.parse().ok()).unwrap_or(0)
}

fn poll_performance_measures(out: &mut impl Write, bundle_id: &str, interval_ms: u128) {
    set_current_thread_name("FL-Main");

    // We read atrace lines before the app is started
    // since it can take a bit of time to start and clear the traceOutputPath
    // but we'll clear them out periodically while the app isn't started.
    // The thread is never joined: polling loops forever until killed. If
    // atrace is unavailable the thread reports it and exits; polling goes on.
    std::thread::Builder::new()
        .name("FL-Atrace".into())
        .spawn(read_atrace_thread)
        .expect("failed to spawn atrace thread");

    // Unlike the C++ version, which recursed and spawned a fresh atrace
    // thread on every pid change, restart via a loop over the same thread.
    loop {
        emit(out, &StatusLine::waiting(bundle_id));

        // The full /proc scan runs on the device under test: 200 ms keeps it
        // cheap while still catching the app well within one measure interval
        let mut pids: Vec<String> = Vec::new();
        while pids.is_empty() {
            clear_atrace_lines();
            pids = pid_of(bundle_id);
            std::thread::sleep(Duration::from_millis(200));
        }

        emit(out, &StatusLine::started(main_pid(&pids)));

        loop {
            match print_performance_measure(out, &pids) {
                Ok(duration_ms) => {
                    if duration_ms > interval_ms {
                        emit(out, &StatusLine::stalled(duration_ms, interval_ms));
                    }
                    let remaining = interval_ms.saturating_sub(duration_ms);
                    std::thread::sleep(Duration::from_millis(remaining as u64));
                }
                Err(error) => {
                    // The TypeScript side resets its aggregation state when
                    // the app process is replaced
                    emit(
                        out,
                        &StatusLine::pid_changed(main_pid(&pids), error.to_string()),
                    );
                    break;
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn set_current_thread_name(name: &str) {
    let mut bytes = name.as_bytes().to_vec();
    bytes.push(0);
    unsafe {
        libc::prctl(libc::PR_SET_NAME, bytes.as_ptr());
    }
}

// prctl is Linux-only; the crate is also unit-tested on macOS hosts
#[cfg(not(target_os = "linux"))]
fn set_current_thread_name(_name: &str) {}

fn print_cpu_clock_tick(out: &mut impl Write) {
    let _ = writeln!(out, "{}", unsafe { libc::sysconf(libc::_SC_CLK_TCK) });
}

fn print_ram_page_size(out: &mut impl Write) {
    let _ = writeln!(out, "{}", unsafe { libc::sysconf(libc::_SC_PAGESIZE) });
}

fn usage_error(msg: impl fmt::Display) -> ! {
    wire::error("USAGE", msg);
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let usage = "Usage: lantern-android-profiler pollPerformanceMeasures <bundleId> <intervalMs> | printPerformanceMeasure <pid> | printCpuClockTick | printRAMPageSize";

    let Some(method_name) = args.get(1) else {
        usage_error(usage);
    };

    match method_name.as_str() {
        "pollPerformanceMeasures" => {
            let (Some(bundle_id), Some(interval)) = (args.get(2), args.get(3)) else {
                usage_error(usage);
            };
            let interval_ms: u128 = interval
                .parse()
                .unwrap_or_else(|_| usage_error(format!("Invalid interval: {interval}")));

            poll_performance_measures(&mut out, bundle_id, interval_ms);
        }
        "printPerformanceMeasure" => {
            let Some(pid) = args.get(2) else {
                usage_error(usage);
            };
            let pids = vec![pid.clone()];
            if let Err(error) = print_performance_measure(&mut out, &pids) {
                wire::error("PID_CLOSED", error);
                drop(out);
                std::process::exit(1);
            }
        }
        "printCpuClockTick" => print_cpu_clock_tick(&mut out),
        "printRAMPageSize" => print_ram_page_size(&mut out),
        other => usage_error(format!("Unknown method name: {other}\n{usage}")),
    }
}
