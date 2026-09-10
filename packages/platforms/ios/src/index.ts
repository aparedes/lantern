import fs from "fs";
import path from "path";
import { Logger } from "@lantern/logger";
import {
  ProfilerLine,
  ProfilingSessionBase,
  StatusLine,
  selectDevice,
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
import { ServeClient } from "./serveClient";

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

/** One entry of the binary's `devices` result. */
interface BinaryDevice {
  udid: string;
  connectionType: string;
  productType: string | null;
  productVersion: string | null;
  deviceName: string | null;
}

/** One entry of the binary's `apps` / `running-apps` result. */
interface BinaryApp {
  bundleId: string;
  name: string;
  executableName: string | null;
  kind: string;
  pid?: number;
}

/**
 * usbmuxd lists a device once per transport (USB, and again over the network when Wi-Fi sync
 * is on): one `DeviceInfo` per udid, described from the USB entry when there is one.
 */
export const toDeviceInfos = (devices: BinaryDevice[]): DeviceInfo[] => {
  const byUdid = new Map<string, BinaryDevice>();
  for (const device of devices) {
    const known = byUdid.get(device.udid);
    if (!known || (known.connectionType !== "Usb" && device.connectionType === "Usb")) {
      byUdid.set(device.udid, device);
    }
  }

  return Array.from(byUdid.values(), (device) => ({
    id: device.udid,
    name: device.deviceName ?? device.productType ?? device.udid,
    platform: "ios" as const,
    model: device.productType ?? undefined,
  }));
};

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

/** One `poll` over the profiler's `serve` child, which outlives the session. */
class IOSProfilingSession extends ProfilingSessionBase {
  private stopRequested = false;

  constructor(
    bundleId: string,
    private readonly client: ServeClient,
    /** Resolves the device (so an ambiguous or unknown `--device` fails here, with its message) */
    private readonly prepare: () => Promise<void>,
    options: StartSessionOptions = {}
  ) {
    super(bundleId, options);
    this.start();
  }

  protected async launch(): Promise<void> {
    await this.prepare();
    if (this.disposed) {
      this.emitEnded("disposed before the profiler started");
      return;
    }

    // Registered before the request: the `started` status can share a chunk with the response
    this.client.beginStream({
      onLine: (line) => this.onLine(line as ProfilerLine<MeasureLine>),
      onClosed: (reason) => this.end(reason),
    });
    try {
      await this.client.request("poll", {
        bundleId: this.bundleId,
        intervalMs: POLLING_INTERVAL,
        fps: true,
      });
    } catch (error) {
      this.client.endStream();
      throw error;
    }
  }

  private onLine(line: ProfilerLine<MeasureLine>) {
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
      case "status":
        this.onStatus(line as StatusLine);
        break;
    }
  }

  private onStatus(line: StatusLine) {
    const message = `iOS profiler: ${line.event}${line.detail ? ` (${line.detail})` : ""}`;
    switch (line.event) {
      case "started":
        this.emitStarted();
        Logger.debug(message);
        break;
      case "stalled":
        Logger.warn(message);
        break;
      case "stopped":
        this.end("stopped");
        break;
      case "ended":
        this.end(`the profiler stream ended${line.detail ? ` (${line.detail})` : ""}`);
        break;
      default:
        Logger.debug(message);
    }
  }

  /** The poll is over: release the stream and settle the session. */
  private end(reason: string) {
    this.client.endStream();
    if (!this.stopRequested && !this.hasEnded) {
      Logger.error(`${reason}: no more measures will be collected`);
    }
    this.emitEnded(reason);
  }

  protected async doStop(): Promise<void> {
    this.stopRequested = true;
    if (!this.hasEnded) {
      // Answered after the `stopped` status, i.e. once the taps are torn down. A stop after
      // the stream ended on its own is a no-op for the binary, and `ended` already fired.
      await this.client.request("stop").catch((error: Error) => this.end(error.message));
    }
    await this.ended;
  }

  protected doDispose(): void {
    this.stopRequested = true;
    if (this.hasEnded) return;
    if (this.client.isRunning) {
      // Not awaited: the session ends when the `stopped` status arrives; the child stays for
      // the next session
      this.client.request("stop").catch(() => {});
    } else {
      this.end("disposed before the profiler started");
    }
  }
}

export interface IOSProfilerOptions {
  /** The device's UDID; when omitted, the only connected device is used. */
  udid?: string;
}

export class IOSProfiler implements Profiler {
  /** The `--device` UDID the caller asked for, before resolution. */
  readonly requestedDevice: string | undefined;
  private readonly client: ServeClient;
  private device: Promise<DeviceInfo> | undefined;
  private refreshRate: number | undefined;

  constructor({ udid }: IOSProfilerOptions = {}) {
    this.requestedDevice = udid;
    this.client = new ServeClient({ binaryPath: getBinaryPath, udid, binaryName: BINARY_NAME });
  }

  /**
   * The device every request targets: the requested UDID, else the only connected device.
   * Resolved once, on first use, so that a plain `listDevices()` never needs a device. The
   * binary applies the same rule on its own (see connect.rs), passing `--udid` just makes both
   * sides agree when several devices are connected.
   */
  resolveDevice(): Promise<DeviceInfo> {
    this.device ??= this.listDevices().then((devices) => {
      const device = selectDevice(devices, {
        requested: this.requestedDevice,
        platformName: "iOS",
        idLabel: "udid",
      });
      // From here on both sides target the same device, even if the set of connected ones changes
      this.client.pinUdid(device.id);
      return device;
    });
    // A failed resolution is not final: the device may get plugged in before the next call
    this.device.catch(() => {
      this.device = undefined;
    });

    return this.device;
  }

  startSession(bundleId: string, options: StartSessionOptions = {}): ProfilingSession {
    if (options.recording) {
      Logger.warn("Screen recording is not supported on iOS, no video will be recorded");
    }

    return new IOSProfilingSession(
      bundleId,
      this.client,
      async () => {
        await this.resolveDevice();
      },
      { ...options, recording: undefined }
    );
  }

  async detectCurrentBundleId(): Promise<string> {
    await this.resolveDevice();
    const running = await this.client.request<BinaryApp[]>("running-apps");

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
    await this.resolveDevice();
    const apps = await this.client.request<BinaryApp[]>("apps");
    const running = await this.client
      .request<BinaryApp[]>("running-apps")
      .catch((error: unknown) => {
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

  async listDevices(): Promise<DeviceInfo[]> {
    try {
      return toDeviceInfos(await this.client.request<BinaryDevice[]>("devices"));
    } catch (error) {
      Logger.debug(
        `${BINARY_NAME} devices failed: ${error instanceof Error ? error.message : error}`
      );

      return [];
    }
  }

  async installProfilerOnDevice(): Promise<void> {
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
    try {
      await this.resolveDevice();
      await this.client.request("kill", { bundleId });
    } catch (error) {
      Logger.debug(`Could not stop ${bundleId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async detectDeviceRefreshRate(): Promise<number> {
    if (this.refreshRate !== undefined) return this.refreshRate;

    // The device's `hardwareInformation` only reports CPU keys, so ProMotion is deduced from
    // the model identifier. `LANTERN_IOS_REFRESH_RATE` is the escape hatch.
    const override = Number(process.env.LANTERN_IOS_REFRESH_RATE);
    if (override > 0) return (this.refreshRate = override);

    const { model } = await this.resolveDevice();
    this.refreshRate = model && isProMotionModel(model) ? 120 : 60;
    Logger.info(`Target frame rate: ${this.refreshRate} Hz${model ? ` (${model})` : ""}`);

    return this.refreshRate;
  }

  /** Ends the `serve` child; the next call would spawn a new one. */
  dispose(): void {
    this.client.dispose();
  }
}
