import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createInterface } from "readline";
import { Logger } from "@lantern/logger";
import {
  ERROR_MARKER,
  ProfilingSessionBase,
  describeExit,
  terminateChild,
  lastErrorMessage,
  parseMarkerLine,
  parseProfilerLine,
} from "@lantern/profiler-protocol";
import {
  AppInfo,
  DeviceInfo,
  Measure,
  POLLING_INTERVAL,
  Profiler,
  ProfilingSession,
  StartSessionOptions,
} from "@lantern/types";

const BINARY_NAME = "lantern-ios-profiler";

// Resolves to <package root>/rust-profiler/bin, from either src/ or dist/src/. Checks the
// actual parent directory name: a checkout path containing "dist" must not change the result.
const isCompiled = path.basename(path.dirname(__dirname)) === "dist";
const defaultBinaryPath = path.join(
  __dirname,
  "..",
  ...(isCompiled ? [".."] : []),
  "rust-profiler",
  "bin",
  BINARY_NAME
);

// Allow overriding the binary path with an environment variable, mirroring
// LANTERN_BINARY_PATH on Android
const getBinaryPath = () => process.env.LANTERN_IOS_BINARY_PATH || defaultBinaryPath;

const MAX_BUFFER = 64 * 1024 * 1024;

/** One entry of the binary's `devices` output. */
interface BinaryDevice {
  udid: string;
  productType: string | null;
  productVersion: string | null;
  deviceName: string | null;
}

/** One entry of the binary's `apps` / `running-apps` output. */
interface BinaryApp {
  bundleId: string;
  name: string;
  executableName: string | null;
  kind: string;
  pid?: number;
}

/**
 * The binary reports failures as `LANTERN_PROFILER_ERROR_*` on stderr and exits non-zero, which
 * `execFileSync`/`execFile` surface as an unhelpful "Command failed" — so re-throw with the
 * message the binary actually wrote whenever there is one.
 */
const toBinaryError = (error: unknown): Error => {
  const stderr = (error as { stderr?: string | Buffer | null }).stderr;
  const message = stderr ? lastErrorMessage(stderr.toString()) : undefined;

  if (message) return new Error(message);

  return error instanceof Error ? error : new Error(String(error));
};

const runBinarySync = <T>(args: string[]): T => {
  try {
    return JSON.parse(
      execFileSync(getBinaryPath(), args, {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        // Capture stderr instead of letting it through to the terminal: `listDevices` probes
        // for a device and swallows failures, and the marker line is re-thrown as the message.
        stdio: ["ignore", "pipe", "pipe"],
      })
    );
  } catch (error) {
    throw toBinaryError(error);
  }
};

const runBinary = <T>(args: string[]): Promise<T> =>
  new Promise((resolve, reject) =>
    execFile(getBinaryPath(), args, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(lastErrorMessage(stderr) ?? error.message));

        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    })
  );

/**
 * ProMotion (120 Hz) models; everything else reports 60. Best-effort table — the
 * `LANTERN_IOS_REFRESH_RATE` env var overrides it for models we got wrong.
 */
const PROMOTION_IPHONES = new Set([
  "iPhone14,2",
  "iPhone14,3", // 13 Pro / Pro Max
  "iPhone15,2",
  "iPhone15,3", // 14 Pro / Pro Max
  "iPhone16,1",
  "iPhone16,2", // 15 Pro / Pro Max
  "iPhone17,1",
  "iPhone17,2", // 16 Pro / Pro Max (16e is iPhone17,5 → 60 Hz)
]);

export const isProMotionModel = (productType: string) => {
  const match = productType.match(/^(iPhone|iPad)(\d+),(\d+)$/);
  if (!match) return false;

  const [, family, major, minor] = match;
  const gen = Number(major);
  const variant = Number(minor);

  if (family === "iPhone") {
    // The whole iPhone 17 line (iPhone18,x and later generations) ships ProMotion.
    return PROMOTION_IPHONES.has(productType) || gen >= 18;
  }

  // iPad Pro only: 10.5"/12.9" 2nd gen (iPad7,1-4), 2018/2020 (iPad8,x), M1 (iPad13,4-11),
  // M2 (iPad14,3-6), M4 (iPad16,3-6). Air and mini are 60 Hz.
  return (
    (gen === 7 && variant <= 4) ||
    gen === 8 ||
    (gen === 13 && variant >= 4 && variant <= 11) ||
    (gen === 14 && variant >= 3 && variant <= 6) ||
    (gen === 16 && variant >= 3 && variant <= 6)
  );
};

interface MeasureLine {
  type: "measure";
  time: number;
  cpu: { perName: { [name: string]: number }; perCore: { [core: number]: number } };
  ram: number;
  fps?: number;
  threadCount: number;
  pid: number;
}

/** Owns the `poll` child of one iOS profiling run. */
class IOSProfilingSession extends ProfilingSessionBase {
  private child: ChildProcess | undefined;
  private stopRequested = false;

  constructor(bundleId: string, options: StartSessionOptions = {}) {
    super(bundleId, options);
    this.start();
  }

  protected async launch(): Promise<void> {
    const child = spawn(getBinaryPath(), [
      "poll",
      "--bundle-id",
      this.bundleId,
      "--interval-ms",
      `${POLLING_INTERVAL}`,
    ]);
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (rawLine) => {
      const line = parseProfilerLine<MeasureLine>(rawLine);
      if (!line) {
        Logger.debug(`Unparseable profiler output: ${rawLine}`);
        return;
      }

      switch (line.type) {
        case "measure": {
          const measure: Measure = {
            cpu: line.cpu,
            ram: line.ram,
            fps: line.fps,
            time: line.time,
          };
          this.emitMeasure(measure);
          break;
        }
        case "status": {
          if (line.event === "started") this.emitStarted();
          const message = `iOS profiler: ${line.event}${line.detail ? ` (${line.detail})` : ""}`;
          if (line.event === "stalled") {
            Logger.warn(message);
          } else {
            Logger.debug(message);
          }
          break;
        }
      }
    });

    createInterface({ input: child.stderr }).on("line", (line) => {
      const marker = parseMarkerLine(line);
      if (marker?.level === "error") {
        Logger.error(line);
      } else if (marker) {
        Logger.warn(line);
      } else {
        Logger.debug(line);
      }
    });

    child.on("error", (error) => {
      Logger.error(
        `Failed to start ${getBinaryPath()}: ${error.message}. Build it with packages/platforms/ios/rust-profiler/build_macos.sh or set LANTERN_IOS_BINARY_PATH.`
      );
    });

    child.on("close", (code, signal) => {
      const exit = describeExit(code, signal);
      const reason = this.stopRequested
        ? `stopped (${exit})`
        : `${BINARY_NAME} exited unexpectedly (${exit})`;
      if (!this.stopRequested) {
        Logger.error(
          `${reason}: no more measures will be collected. Check the ${ERROR_MARKER}* lines above.`
        );
      }
      this.emitEnded(reason);
    });
  }

  protected async doStop(): Promise<void> {
    this.terminate();
    await this.ended;
  }

  protected doDispose(): void {
    this.terminate();
  }

  private terminate() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (!this.child) return;
    terminateChild(this.child, {
      onEscalate: () => Logger.warn(`${BINARY_NAME} did not exit after SIGINT, sending SIGKILL`),
    });
  }
}

export class IOSProfiler implements Profiler {
  private refreshRate: number | undefined;

  startSession(bundleId: string, options: StartSessionOptions = {}): ProfilingSession {
    if (options.recording) {
      Logger.warn("Screen recording is not supported on iOS, no video will be recorded");
    }

    return new IOSProfilingSession(bundleId, { ...options, recording: undefined });
  }

  detectCurrentBundleId(): string {
    const running = runBinarySync<BinaryApp[]>(["running-apps"]);

    if (running.length === 1) return running[0].bundleId;

    if (running.length === 0) {
      throw new Error(
        "No app is running on the iOS device: open the app you want to measure, or pick it from the list"
      );
    }

    throw new Error(
      `Several apps are running on the iOS device (${running
        .map((app) => app.bundleId)
        .join(", ")}): pick one from the list`
    );
  }

  async listApps(): Promise<AppInfo[]> {
    // Sequential on purpose: each subcommand opens its own instruments connection, and iOS 26
    // closes concurrent dtservicehub connections.
    const apps = await runBinary<BinaryApp[]>(["apps"]);
    const running = await runBinary<BinaryApp[]>(["running-apps"]).catch((error: unknown) => {
      Logger.warn(
        `Could not list running apps, none will be flagged as running: ${
          error instanceof Error ? error.message : error
        }`
      );

      return [] as BinaryApp[];
    });
    const runningIds = new Set(running.map((app) => app.bundleId));

    return apps
      .map(({ bundleId, name }) => ({ bundleId, name, isRunning: runningIds.has(bundleId) }))
      .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || a.name.localeCompare(b.name));
  }

  listDevices(): DeviceInfo[] {
    try {
      return runBinarySync<BinaryDevice[]>(["devices"]).map((device) => ({
        id: device.udid,
        name: device.deviceName ?? device.productType ?? device.udid,
        platform: "ios" as const,
        model: device.productType ?? undefined,
      }));
    } catch (error) {
      Logger.debug(
        `lantern-ios-profiler devices failed: ${error instanceof Error ? error.message : error}`
      );

      return [];
    }
  }

  installProfilerOnDevice() {
    const binaryPath = getBinaryPath();
    if (!process.env.LANTERN_IOS_BINARY_PATH && !fs.existsSync(binaryPath)) {
      throw new Error(
        `${BINARY_NAME} not found at ${binaryPath}. Build it with packages/platforms/ios/rust-profiler/build_macos.sh (macOS only) or set LANTERN_IOS_BINARY_PATH.`
      );
    }
  }

  supportsScreenRecording(): boolean {
    return false;
  }

  async stopApp(bundleId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile(getBinaryPath(), ["kill", "--bundle-id", bundleId], (error) => {
        if (error) {
          Logger.debug(`Could not stop ${bundleId}: ${error.message}`);
        }
        resolve();
      });
    });
  }

  detectDeviceRefreshRate(): number {
    if (this.refreshRate !== undefined) return this.refreshRate;

    // The device's `hardwareInformation` only reports CPU keys, so ProMotion is deduced from
    // the model identifier. `LANTERN_IOS_REFRESH_RATE` is the escape hatch.
    const override = Number(process.env.LANTERN_IOS_REFRESH_RATE);
    if (override > 0) return (this.refreshRate = override);

    const model = this.listDevices()[0]?.model;
    this.refreshRate = model && isProMotionModel(model) ? 120 : 60;
    Logger.info(`Target frame rate: ${this.refreshRate} Hz${model ? ` (${model})` : ""}`);

    return this.refreshRate;
  }
}
