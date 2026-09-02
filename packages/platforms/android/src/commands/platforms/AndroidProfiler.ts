import fs from "fs";
import os from "os";
import { Logger } from "@lantern/logger";
import {
  AppInfo,
  DeviceInfo,
  Profiler,
  ProfilingSession,
  StartSessionOptions,
} from "@lantern/types";
import { selectDevice } from "@lantern/profiler-protocol";
import { adb } from "../adb";
import { getAbi } from "../getAbi";
import { detectCurrentAppBundleId } from "../detectCurrentAppBundleId";
import { refreshRateManager } from "../detectCurrentDeviceRefreshRate";
import { listAndroidDevices } from "../listDevices";
import { listInstalledApps } from "../listInstalledApps";
import { isDeviceProcessRunning } from "../isDeviceProcessRunning";
import { waitFor } from "../../utils/waitFor";
import { AndroidProfilingSession } from "./AndroidSession";

export const CppProfilerName = `lantern-android-profiler`;

const defaultBinaryFolder = `${__dirname}/../../..${__dirname.includes("dist") ? "/.." : ""}/rust-profiler/bin`;
// Allow overriding the binary folder with an environment variable
const getBinaryFolder = () => process.env.LANTERN_BINARY_PATH || defaultBinaryFolder;

const STOP_APP_TIMEOUT = 5000;
/** The profiler binary draws no frames; the value only has to exist for the report. */
const SELF_PROFILING_REFRESH_RATE = 60;

export interface AndroidProfilerOptions {
  /** `adb -s` serial; when omitted, the only connected device is used. */
  serial?: string;
  /**
   * Measure the profiler binary itself rather than an app (used to profile Lantern): no atrace,
   * no FPS, and a distinct binary name so that the measured Lantern process and the measuring
   * one never confuse each other's profiler.
   */
  selfProfiling?: boolean;
}

export class AndroidProfiler implements Profiler {
  /** The `--device` serial the caller asked for, before resolution. */
  readonly requestedDevice: string | undefined;
  private readonly selfProfiling: boolean;
  private device: Promise<DeviceInfo> | undefined;
  private installation: Promise<void> | undefined;
  private cpuClockTick: number | undefined;
  private RAMPageSize: number | undefined;

  constructor({ serial, selfProfiling = false }: AndroidProfilerOptions = {}) {
    this.requestedDevice = serial;
    this.selfProfiling = selfProfiling;
  }

  /**
   * The device every adb call targets: the requested serial, else the only connected device.
   * Resolved once, on first use, so that a plain `listDevices()` never needs a device.
   */
  resolveDevice(): Promise<DeviceInfo> {
    this.device ??= this.listDevices().then((devices) =>
      selectDevice(devices, {
        requested: this.requestedDevice,
        platformName: "Android",
        idLabel: "serial",
      })
    );
    // A failed resolution is not final: the device may get plugged in before the next call
    this.device.catch(() => {
      this.device = undefined;
    });

    return this.device;
  }

  private async serial(): Promise<string> {
    return (await this.resolveDevice()).id;
  }

  /**
   * Main setup function for the native (Rust) profiler
   *
   * It will:
   * - install the profiler binary for the correct architecture on the device
   * - Populate needed values like CPU clock tick and RAM page size
   * - Detect the device's refresh rate, the FPS target
   *
   * This needs to be done before measures and can take a few seconds. Concurrent and repeated
   * calls share the first installation; a failed one is retried by the next call.
   */
  installProfilerOnDevice(): Promise<void> {
    this.installation ??= this.install();
    this.installation.catch(() => {
      this.installation = undefined;
    });

    return this.installation;
  }

  private async install(): Promise<void> {
    const serial = await this.serial();
    this.assertSupported(serial);
    this.installCppProfilerOnDevice(serial);
    this.cpuClockTick = this.readDeviceNumber(serial, "printCpuClockTick");
    this.RAMPageSize = this.readDeviceNumber(serial, "printRAMPageSize");
    await this.detectDeviceRefreshRate();
  }

  private readDeviceNumber(serial: string, profilerCommand: string): number {
    return parseInt(adb(["shell", this.getDeviceProfilerPath(), profilerCommand], { serial }), 10);
  }

  /** Known once `installProfilerOnDevice` resolved. */
  getCpuClockTick(): number {
    if (!this.cpuClockTick) {
      throw new Error("CPU clock tick not initialized");
    }
    return this.cpuClockTick;
  }

  /** Known once `installProfilerOnDevice` resolved. */
  getRAMPageSize(): number {
    if (!this.RAMPageSize) {
      throw new Error("RAM Page size not initialized");
    }
    return this.RAMPageSize;
  }

  private assertSupported(serial: string): void {
    const sdkVersion = parseInt(adb(["shell", "getprop", "ro.build.version.sdk"], { serial }), 10);

    if (sdkVersion < 24) {
      throw new Error(
        `Your Android version (sdk API level ${sdkVersion}) is not supported. Supported versions > 23.`
      );
    }
  }

  private installCppProfilerOnDevice(serial: string): void {
    const abi = getAbi(serial);
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

    const devicePath = this.getDeviceProfilerPath();
    adb(["push", binaryTmpPath, devicePath], { serial });
    adb(["shell", "chmod", "755", devicePath], { serial });
    Logger.success(`Profiler installed in ${devicePath}`);
  }

  public getDeviceProfilerPath(): string {
    return `/data/local/tmp/${CppProfilerName}${this.selfProfiling ? "_SELF_REPORT" : ""}`;
  }

  /**
   * Starts the native profiler on the device for `bundleId`, along with atrace (for FPS) and
   * the screen recorder when asked: the returned session owns all of them. The device is
   * resolved and the profiler installed as part of the session's launch.
   */
  startSession(bundleId: string, options: StartSessionOptions = {}): ProfilingSession {
    return new AndroidProfilingSession(
      bundleId,
      async () => {
        await this.installProfilerOnDevice();

        return {
          serial: await this.serial(),
          deviceProfilerPath: this.getDeviceProfilerPath(),
          profilerName: CppProfilerName,
          cpuClockTick: this.getCpuClockTick(),
          ramPageSize: this.getRAMPageSize(),
          supportFPS: this.supportFPS(),
          withAtrace: !this.selfProfiling,
        };
      },
      options
    );
  }

  public supportsScreenRecording(): boolean {
    return true;
  }

  public supportFPS(): boolean {
    return !this.selfProfiling;
  }

  public async detectCurrentBundleId(): Promise<string> {
    if (this.selfProfiling) return CppProfilerName;

    return detectCurrentAppBundleId(await this.serial()).bundleId;
  }

  async stopApp(bundleId: string) {
    const serial = await this.serial();
    adb(["shell", "am", "force-stop", bundleId], { serial });
    try {
      await waitFor(() => !isDeviceProcessRunning(bundleId, serial), {
        timeout: STOP_APP_TIMEOUT,
        checkInterval: 100,
      });
    } catch {
      Logger.warn(`${bundleId} is still running ${STOP_APP_TIMEOUT}ms after force-stop`);
    }
  }

  /**
   * Detected once per process (`refreshRateManager` is what `FrameTimeParser.getFps` reads
   * synchronously while measures flow).
   */
  public async detectDeviceRefreshRate(): Promise<number> {
    if (this.selfProfiling) return SELF_PROFILING_REFRESH_RATE;

    if (!refreshRateManager.isInitialized()) {
      refreshRateManager.setRefreshRate(await this.serial());
    }

    return refreshRateManager.getRefreshRate();
  }

  public async listApps(): Promise<AppInfo[]> {
    return listInstalledApps(await this.serial());
  }

  public async listDevices(): Promise<DeviceInfo[]> {
    return listAndroidDevices();
  }

  /** Nothing outlives a session on Android: every adb call is a one-shot. */
  public dispose(): void {}
}
