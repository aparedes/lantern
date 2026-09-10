import { ChildProcess } from "child_process";
import { basename, dirname } from "path";
import { createInterface } from "readline";
import { Logger } from "@lantern/logger";
import { Measure, POLLING_INTERVAL, StartSessionOptions, ThreadNames } from "@lantern/types";
import {
  AndroidRawMeasureLine,
  ProfilingSessionBase,
  describeExit,
  isAndroidRawMeasureLine,
  parseMarkerLine,
  parseProfilerLine,
  terminateChild,
} from "@lantern/profiler-protocol";
import { adb, adbAsync, adbIgnoringOutput } from "../adb";
import { canIgnoreAwsTerminationError } from "../shell";
import { CpuMeasureAggregator } from "../cpu/CpuMeasureAggregator";
import { FrameTimeParser } from "../atrace/pollFpsUsage";
import { processOutput } from "../cpu/getCpuStatsByProcess";
import { processOutput as processRamOutput } from "../ram/pollRamUsage";
import { ScreenRecorder } from "../ScreenRecorder";

/**
 * atrace only traces for the duration given with `-t` (default 5 s, and there is no "forever"),
 * after which it disables tracing and exits: the profiler then gets no more frame data and
 * FPS silently degrades. We use the longest practical duration and restart atrace when it
 * exits on its own (see `startATrace`).
 */
const ATRACE_ARGS = ["shell", "atrace", "-c", "view", "-t", "999"];
const ATRACE_STOP_ARGS = ["shell", "atrace", "--async_stop"];

const enableFpsDebug = (serial?: string) =>
  adb(["shell", "setprop", "debug.hwui.profile", "true"], { serial });

/**
 * Leaves the device's tracing off. The output of `atrace --async_stop` can be big enough to
 * overflow the buffer (see https://stackoverflow.com/questions/63796633/spawnsync-bin-sh-enobufs),
 * so it is ignored; a failure (e.g. the device is gone) is not worth more than a debug line.
 */
const stopDeviceTracing = (serial?: string) => {
  try {
    adbIgnoringOutput(ATRACE_STOP_ARGS, { serial });
  } catch (error) {
    Logger.debug(
      `Could not stop atrace on the device: ${error instanceof Error ? error.message : error}`
    );
  }
};

export interface AndroidSessionConfig {
  /** The device every adb call targets. */
  serial: string;
  /** Where the profiler binary was pushed on the device. */
  deviceProfilerPath: string;
  /** Human name of the profiler binary, for messages. */
  profilerName: string;
  cpuClockTick: number;
  ramPageSize: number;
  supportFPS: boolean;
  /** Trace `view` events for FPS; off when profiling the profiler itself. */
  withAtrace: boolean;
}

/**
 * Owns every process behind one Android profiling run: the atrace tracer, the on-device
 * profiler (polled through `adb shell`) and the screen recorder when one was requested.
 */
export class AndroidProfilingSession extends ProfilingSessionBase {
  private aTraceProcess: ChildProcess | null = null;
  private profilerProcess: ChildProcess | undefined;
  private recorder: ScreenRecorder | undefined;
  /** The app was replaced; `restarted` waits for the new process's baseline sample. */
  private restarting = false;
  private recordingStarted = false;
  private stopRequested = false;
  /** Known once `prepare` resolved (device resolved, profiler installed). */
  private config: AndroidSessionConfig | undefined;

  constructor(
    bundleId: string,
    /** Resolves the device and installs the profiler; its failure ends the session */
    private readonly prepare: () => Promise<AndroidSessionConfig>,
    options: StartSessionOptions = {}
  ) {
    super(bundleId, options);
    this.start();
  }

  /** The configuration, once the session is past its preparation. */
  private get cfg(): AndroidSessionConfig {
    if (!this.config) throw new Error("The session is not prepared yet");

    return this.config;
  }

  protected async launch(): Promise<void> {
    this.config = await this.prepare();
    if (this.disposed || this.stopRequested) {
      this.emitEnded("stopped before the profiler started");
      return;
    }

    const { recording } = this.options;
    if (recording) {
      this.recorder = new ScreenRecorder(basename(recording.videoPath), this.config.serial);
      await this.recorder.startRecording({ bitRate: recording.bitRate, size: recording.size });
      this.recordingStarted = true;
      this.recordingStartTime = this.recorder.getRecordingStartTime();
    }

    // Stopped while the recording was starting: there is nothing left to measure
    if (this.disposed || this.stopRequested) {
      this.emitEnded("stopped before the profiler started");
      return;
    }

    if (this.cfg.withAtrace) this.startATrace();
    this.spawnProfiler();
  }

  protected async doStop(): Promise<void> {
    this.stopRequested = true;
    if (this.profilerProcess) {
      terminateChild(this.profilerProcess, {
        onEscalate: () =>
          Logger.warn(`${this.cfg.profilerName} did not exit after SIGINT, sending SIGKILL`),
      });
      await this.ended;
    } else {
      // `launch()` ends the session itself when it reaches the spawn point after a stop, but
      // it may also have failed before that (recording error): wait for whichever comes first
      await Promise.race([this.ended, this.launched.catch(() => {})]);
      await this.ended;
    }

    this.stopATrace();

    if (this.recorder && this.recordingStarted) {
      await this.recorder.stopRecording();
      // The video path is only known to the caller; put the file next to it
      await this.recorder.pullRecording(dirname(this.options.recording!.videoPath));
    }
  }

  protected doDispose(): void {
    this.stopRequested = true;
    if (this.profilerProcess) {
      terminateChild(this.profilerProcess);
    } else if (!this.hasEnded) {
      // Nothing was spawned yet (or `launch` is still starting the recording): end now so that
      // waiters are released; `launch` checks `disposed` before spawning anything
      this.emitEnded("disposed before the profiler started");
    }
    this.stopATrace();
    this.recorder?.dispose();
  }

  private spawnProfiler() {
    const process = adbAsync(
      [
        "shell",
        this.cfg.deviceProfilerPath,
        "pollPerformanceMeasures",
        this.bundleId,
        `${POLLING_INTERVAL}`,
      ],
      { serial: this.cfg.serial, logStderr: false }
    );
    this.profilerProcess = process;

    let initialTime: number | null = null;
    let previousTime: number | null = null;
    let cpuMeasuresAggregator = new CpuMeasureAggregator(this.cfg.cpuClockTick);
    let frameTimeParser = new FrameTimeParser();

    const reset = () => {
      initialTime = null;
      previousTime = null;
      cpuMeasuresAggregator = new CpuMeasureAggregator(this.cfg.cpuClockTick);
      frameTimeParser = new FrameTimeParser();
    };

    const onRawMeasure = ({ pid, cpu, ram: ramStr, atrace, timestamp }: AndroidRawMeasureLine) => {
      if (!atrace) {
        Logger.debug("NO ATRACE OUTPUT, if the app is idle, that is normal");
      }
      const subProcessesStats = processOutput(cpu, pid);
      const ram = processRamOutput(ramStr, this.cfg.ramPageSize);

      let output;
      try {
        output = frameTimeParser.getFrameTimes(atrace, pid);
      } catch (e) {
        console.error(e);
      }
      if (!output) return;

      const { frameTimes, interval: atraceInterval } = output;

      if (!initialTime) initialTime = timestamp;

      if (previousTime) {
        const interval = timestamp - previousTime;
        const cpuMeasures = cpuMeasuresAggregator.process(subProcessesStats, interval);
        const fps = FrameTimeParser.getFps(
          frameTimes,
          atraceInterval,
          Math.max(
            cpuMeasures.perName[ThreadNames.ANDROID.UI] || 0,
            // Hack for Flutter apps - if this thread is heavy app will be laggy
            cpuMeasures.perName[ThreadNames.FLUTTER.UI] || 0
          )
        );
        const measure: Measure = this.cfg.supportFPS
          ? { cpu: cpuMeasures, fps, ram, time: timestamp - initialTime }
          : { cpu: cpuMeasures, ram, time: timestamp - initialTime };
        this.emitMeasure(measure);
      } else {
        // The first sample is the baseline the next ones are diffed against
        cpuMeasuresAggregator.initStats(subProcessesStats);
        if (this.restarting) {
          // Held back from `pid_changed`: the profiler reports that as soon as the old `/proc`
          // is gone, then waits for the replacement to come up. Restarting the run's timing
          // there would count the relaunch downtime as test runtime, so it waits for the
          // baseline of the new process, which is this sample.
          this.restarting = false;
          this.emitRestarted();
        } else {
          this.emitStarted();
        }
      }
      previousTime = timestamp;
    };

    if (process.stdout) {
      createInterface({ input: process.stdout }).on("line", (rawLine: string) => {
        const line = parseProfilerLine<AndroidRawMeasureLine>(rawLine);
        if (!line) {
          Logger.debug(`Unparseable profiler output: ${rawLine}`);
          return;
        }

        if (line.type === "measure") {
          // The binary is trusted, but a truncated line must not crash the parsers
          if (isAndroidRawMeasureLine(line)) {
            Logger.trace(rawLine);
            onRawMeasure(line);
          } else {
            Logger.warn(`Skipping a malformed measure from the profiler: ${rawLine}`);
          }
          return;
        }

        if (line.type === "status") {
          const message = `Android profiler: ${line.event}${line.detail ? ` (${line.detail})` : ""}`;
          switch (line.event) {
            case "pid_changed":
              Logger.warn("Process id has changed, ignoring measures until now");
              reset();
              this.restarting = true;
              break;
            case "stalled":
              Logger.warn(message);
              break;
            default:
              Logger.debug(message);
          }
          return;
        }

        Logger.debug(`Unknown profiler line type: ${rawLine}`);
      });
    }

    if (process.stderr) {
      createInterface({ input: process.stderr }).on("line", (log) => {
        const marker = parseMarkerLine(log);
        if (!marker) {
          if (log && !canIgnoreAwsTerminationError(log)) Logger.error(log);
          return;
        }

        if (marker.level === "error") {
          Logger.error(log);
        } else if (marker.code === "CANNOT_OPEN_FILE") {
          // A thread died between the directory listing and the read: expected, not an error
          Logger.debug(log);
        } else {
          Logger.warn(log);
        }
      });
    }

    process.on("close", (code, signal) => {
      const exit = describeExit(code, signal);
      const reason = this.stopRequested
        ? `stopped (${exit})`
        : `${this.cfg.profilerName} exited unexpectedly (${exit})`;
      if (!this.stopRequested) {
        Logger.error(`${reason}: no more measures will be collected`);
      }
      this.emitEnded(reason);
    });
  }

  private startATrace() {
    // Done here rather than at import time so that a machine without `adb` (iOS only) can
    // still load this package.
    enableFpsDebug(this.cfg.serial);

    Logger.debug("Stopping atrace and flushing output...");
    stopDeviceTracing(this.cfg.serial);
    Logger.debug("Starting atrace...");
    const aTraceProcess = adbAsync(ATRACE_ARGS, { serial: this.cfg.serial });
    this.aTraceProcess = aTraceProcess;

    // atrace dumps its buffer on stdout when it stops, drain it so it never blocks on a full pipe
    aTraceProcess.stdout?.on("data", () => {});

    aTraceProcess.on("close", (code) => {
      // Stopped by us (`stopATrace` clears the reference first): nothing to restart
      if (this.aTraceProcess !== aTraceProcess) return;
      this.aTraceProcess = null;

      if (code !== 0) {
        // e.g. the device got disconnected or tracing is unavailable: respawning right away would
        // loop tightly, and the adb commands below would throw from inside this event handler
        Logger.error(
          `atrace exited with code ${code}, FPS will no longer be measured until the next session`
        );
        return;
      }

      // Its `-t` budget expired (see ATRACE_COMMAND), so trace again
      Logger.debug("atrace exited on its own, restarting it...");
      try {
        this.startATrace();
      } catch (error) {
        Logger.error(
          `Could not restart atrace, FPS will no longer be measured: ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    });
  }

  private stopATrace() {
    // Nothing to stop before the session is prepared, or without atrace
    if (!this.config?.withAtrace) return;
    // We need to close this process, otherwise tests will hang
    Logger.debug("Stopping atrace process...");
    this.aTraceProcess?.kill();
    this.aTraceProcess = null;
    // The device keeps tracing after its client is gone; a stopped session must not leave it on
    stopDeviceTracing(this.cfg.serial);
  }
}
