import fs from "fs";
import os from "os";
import { createInterface } from "readline";
import { Logger } from "@lantern/logger";
import {
  canIgnoreAwsTerminationError,
  cleanup,
  executeCommand,
  executeLineProcess,
} from "../shell";
import {
  AppInfo,
  DeviceInfo,
  POLLING_INTERVAL,
  Profiler,
  ProfilerPollingOptions,
  ScreenRecorder,
  ThreadNames,
} from "@lantern/types";
import { CpuMeasureAggregator } from "../cpu/CpuMeasureAggregator";
import { FrameTimeParser } from "../atrace/pollFpsUsage";
import {
  AndroidRawMeasureLine,
  isAndroidRawMeasureLine,
  parseMarkerLine,
  parseProfilerLine,
} from "@lantern/profiler-protocol";
import { processOutput } from "../cpu/getCpuStatsByProcess";
import { processOutput as processRamOutput } from "../ram/pollRamUsage";

export const CppProfilerName = `lantern-android-profiler`;

const defaultBinaryFolder = `${__dirname}/../../..${__dirname.includes("dist") ? "/.." : ""}/rust-profiler/bin`;
// Allow overriding the binary folder with an environment variable
const getBinaryFolder = () => process.env.LANTERN_BINARY_PATH || defaultBinaryFolder;

export abstract class UnixProfiler implements Profiler {
  private hasInstalledProfiler = false;
  private cpuClockTick: number | undefined;
  private RAMPageSize: number | undefined;

  /**
   * Main setup function for the native (Rust) profiler
   *
   * It will:
   * - install the profiler binary for the correct architecture on the device
   * - Starts the atrace process (the profiler will then starts another thread to read from it)
   * - Populate needed values like CPU clock tick and RAM page size
   *
   * This needs to be done before measures and can take a few seconds
   */
  public installProfilerOnDevice(): void {
    if (!this.hasInstalledProfiler) {
      this.assertSupported();
      this.installCppProfilerOnDevice();
      this.retrieveCpuClockTick();
      this.retrieveRAMPageSize();
    }
    this.hasInstalledProfiler = true;
  }

  private retrieveCpuClockTick() {
    this.cpuClockTick = parseInt(
      executeCommand(this.getDeviceCommand(`${this.getDeviceProfilerPath()} printCpuClockTick`)),
      10
    );
  }

  private retrieveRAMPageSize() {
    this.RAMPageSize = parseInt(
      executeCommand(this.getDeviceCommand(`${this.getDeviceProfilerPath()} printRAMPageSize`)),
      10
    );
  }

  getCpuClockTick(): number {
    this.installProfilerOnDevice();
    if (!this.cpuClockTick) {
      throw new Error("CPU clock tick not initialized");
    }
    return this.cpuClockTick;
  }

  getRAMPageSize(): number {
    this.installProfilerOnDevice();
    if (!this.RAMPageSize) {
      throw new Error("RAM Page size not initialized");
    }
    return this.RAMPageSize;
  }

  private installCppProfilerOnDevice(): void {
    const abi = this.getAbi();
    Logger.info(`Installing profiler for ${abi} architecture`);

    const binaryPath = `${getBinaryFolder()}/${CppProfilerName}-${abi}`;
    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        `Unsupported device ABI "${abi}": no profiler binary is shipped for it (supported: arm64-v8a)`
      );
    }
    const binaryTmpPath = `${os.tmpdir()}/lantern-${CppProfilerName}-${abi}`;

    // Copy to a real file first: when running from the standalone executable the source may be an embedded (virtual) path
    fs.writeFileSync(binaryTmpPath, fs.readFileSync(binaryPath));

    this.pushExecutable(binaryTmpPath);
    Logger.success(`Profiler installed in ${this.getDeviceProfilerPath()}`);
  }

  pollPerformanceMeasures(
    bundleId: string,
    {
      onMeasure,
      onStartMeasuring = () => {
        // noop by default
      },
      onEnd,
    }: ProfilerPollingOptions
  ) {
    let initialTime: number | null = null;
    let previousTime: number | null = null;

    let cpuMeasuresAggregator = new CpuMeasureAggregator(this.getCpuClockTick());
    let frameTimeParser = new FrameTimeParser();

    const reset = () => {
      initialTime = null;
      previousTime = null;
      cpuMeasuresAggregator = new CpuMeasureAggregator(this.getCpuClockTick());
      frameTimeParser = new FrameTimeParser();
    };

    return this.pollRawPerformanceMeasures(
      bundleId,
      ({ pid, cpu, ram: ramStr, atrace, timestamp }) => {
        if (!atrace) {
          Logger.debug("NO ATRACE OUTPUT, if the app is idle, that is normal");
        }
        const subProcessesStats = processOutput(cpu, pid);

        const ram = processRamOutput(ramStr, this.getRAMPageSize());

        let output;
        try {
          output = frameTimeParser.getFrameTimes(atrace, pid);
        } catch (e) {
          console.error(e);
        }

        if (!output) {
          return;
        }

        const { frameTimes, interval: atraceInterval } = output;

        if (!initialTime) {
          initialTime = timestamp;
        }

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

          onMeasure(
            this.supportFPS()
              ? {
                  cpu: cpuMeasures,
                  fps,
                  ram,
                  time: timestamp - initialTime,
                }
              : {
                  cpu: cpuMeasures,
                  ram,
                  time: timestamp - initialTime,
                }
          );
        } else {
          onStartMeasuring();
          cpuMeasuresAggregator.initStats(subProcessesStats);
        }
        previousTime = timestamp;
      },
      () => {
        Logger.warn("Process id has changed, ignoring measures until now");
        reset();
      },
      onEnd
    );
  }

  /**
   * Starts the native profiler on the device and forwards each raw measure it prints
   * (before any CPU / RAM / FPS processing) to `onData`. `onEnd` is called once the profiler
   * process has exited, whether through `stop()` or on its own.
   *
   * The wire protocol (NDJSON on stdout, markers on stderr) is documented in
   * `@lantern/profiler-protocol`.
   */
  private pollRawPerformanceMeasures(
    bundleId: string,
    onData: (measure: AndroidRawMeasureLine) => void,
    onPidChanged?: (bundleId: string) => void,
    onEnd?: (reason: string) => void
  ) {
    this.installProfilerOnDevice();

    const process = executeLineProcess(
      this.getDeviceCommand(
        `${this.getDeviceProfilerPath()} pollPerformanceMeasures ${bundleId} ${POLLING_INTERVAL}`
      ),
      (rawLine: string) => {
        const line = parseProfilerLine<AndroidRawMeasureLine>(rawLine);
        if (!line) {
          Logger.debug(`Unparseable profiler output: ${rawLine}`);
          return;
        }

        if (line.type === "measure") {
          // The binary is trusted, but a truncated line must not crash the parsers below
          if (isAndroidRawMeasureLine(line)) {
            Logger.trace(rawLine);
            onData(line);
          } else {
            Logger.warn(`Skipping a malformed measure from the profiler: ${rawLine}`);
          }
          return;
        }

        if (line.type === "status") {
          const message = `Android profiler: ${line.event}${line.detail ? ` (${line.detail})` : ""}`;
          switch (line.event) {
            case "pid_changed":
              Logger.debug(message);
              onPidChanged?.(bundleId);
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
      }
    );

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

    let stopRequested = false;
    process.on("close", (code, signal) => {
      const exit = signal ? `signal ${signal}` : `code ${code}`;
      const reason = stopRequested
        ? `stopped (${exit})`
        : `${CppProfilerName} exited unexpectedly (${exit})`;
      if (!stopRequested) {
        Logger.error(`${reason}: no more measures will be collected`);
      }
      onEnd?.(reason);
    });

    return {
      stop: () => {
        stopRequested = true;
        process.kill("SIGINT");
        this.stop();
      },
    };
  }

  // Disabling the warning because the method isn't implemented
  // oxlint-disable-next-line no-unused-vars
  public getScreenRecorder(videoPath: string): ScreenRecorder | undefined {
    return undefined;
  }

  // Disabling the warning because the method isn't implemented
  // oxlint-disable-next-line no-unused-vars
  public async stopApp(bundleId: string) {
    throw new Error("Method not implemented.");
  }

  public cleanup() {
    cleanup();
  }

  /** Stops what `installProfilerOnDevice` started (e.g. the atrace process on Android) */
  public abstract stop(): void;
  public abstract getDeviceCommand(command: string): string;
  protected abstract getAbi(): string;
  protected abstract pushExecutable(binaryTmpPath: string): void;
  protected abstract assertSupported(): void;
  public abstract getDeviceProfilerPath(): string;
  public abstract detectCurrentBundleId(): string;
  public abstract supportFPS(): boolean;
  public abstract detectDeviceRefreshRate(): number;
  public abstract listApps(): Promise<AppInfo[]>;
  public abstract listDevices(): DeviceInfo[];
}
