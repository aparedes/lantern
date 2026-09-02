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
  private device: DeviceInfo | undefined;
  private hasInstalledProfiler = false;
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
  resolveDevice(): DeviceInfo {
    this.device ??= selectDevice(listAndroidDevices(), {
      requested: this.requestedDevice,
      platformName: "Android",
      idLabel: "serial",
    });

    return this.device;
  }

  private get serial(): string {
    return this.resolveDevice().id;
  }

  /** `adb <args>` on the resolved device. */
  private adb(args: string[]): string {
    return adb(args, { serial: this.serial });
  }

  /**
   * Main setup function for the native (Rust) profiler
   *
   * It will:
   * - install the profiler binary for the correct architecture on the device
   * - Populate needed values like CPU clock tick and RAM page size
   *
   * This needs to be done before measures and can take a few seconds
   */
  public installProfilerOnDevice(): void {
    if (!this.hasInstalledProfiler) {
      this.assertSupported();
      this.installCppProfilerOnDevice();
      this.cpuClockTick = this.readDeviceNumber("printCpuClockTick");
      this.RAMPageSize = this.readDeviceNumber("printRAMPageSize");
    }
    this.hasInstalledProfiler = true;
    if (!this.selfProfiling && !refreshRateManager.isInitialized()) {
      refreshRateManager.setRefreshRate(this.serial);
    }
  }

  private readDeviceNumber(profilerCommand: string): number {
    return parseInt(this.adb(["shell", this.getDeviceProfilerPath(), profilerCommand]), 10);
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

  private assertSupported(): void {
    const sdkVersion = parseInt(this.adb(["shell", "getprop", "ro.build.version.sdk"]), 10);

    if (sdkVersion < 24) {
      throw new Error(
        `Your Android version (sdk API level ${sdkVersion}) is not supported. Supported versions > 23.`
      );
    }
  }

  private installCppProfilerOnDevice(): void {
    const abi = getAbi(this.serial);
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
    this.adb(["push", binaryTmpPath, devicePath]);
    this.adb(["shell", "chmod", "755", devicePath]);
    Logger.success(`Profiler installed in ${devicePath}`);
  }

  public getDeviceProfilerPath(): string {
    return `/data/local/tmp/${CppProfilerName}${this.selfProfiling ? "_SELF_REPORT" : ""}`;
  }

  /**
   * Starts the native profiler on the device for `bundleId`, along with atrace (for FPS) and
   * the screen recorder when asked: the returned session owns all of them.
   */
  startSession(bundleId: string, options: StartSessionOptions = {}): ProfilingSession {
    this.installProfilerOnDevice();

    return new AndroidProfilingSession(
      bundleId,
      {
        serial: this.serial,
        deviceProfilerPath: this.getDeviceProfilerPath(),
        profilerName: CppProfilerName,
        cpuClockTick: this.getCpuClockTick(),
        ramPageSize: this.getRAMPageSize(),
        supportFPS: this.supportFPS(),
        withAtrace: !this.selfProfiling,
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

  public detectCurrentBundleId(): string {
    if (this.selfProfiling) return CppProfilerName;

    return detectCurrentAppBundleId(this.serial).bundleId;
  }

  async stopApp(bundleId: string) {
    this.adb(["shell", "am", "force-stop", bundleId]);
    try {
      await waitFor(() => !isDeviceProcessRunning(bundleId, this.serial), {
        timeout: STOP_APP_TIMEOUT,
        checkInterval: 100,
      });
    } catch {
      Logger.warn(`${bundleId} is still running ${STOP_APP_TIMEOUT}ms after force-stop`);
    }
  }

  public detectDeviceRefreshRate(): number {
    if (this.selfProfiling) return SELF_PROFILING_REFRESH_RATE;

    return refreshRateManager.getRefreshRate();
  }

  public listApps(): Promise<AppInfo[]> {
    return listInstalledApps(this.serial);
  }

  public listDevices(): DeviceInfo[] {
    return listAndroidDevices();
  }
}
