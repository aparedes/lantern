import fs from "fs";
import os from "os";
import { Logger } from "@lantern/logger";
import { executeCommand } from "../shell";
import {
  AppInfo,
  DeviceInfo,
  POLLING_INTERVAL,
  Profiler,
  ProfilingSession,
  StartSessionOptions,
} from "@lantern/types";
import { AndroidProfilingSession } from "./AndroidSession";

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

  /**
   * Starts the native profiler on the device for `bundleId`, along with atrace (for FPS) and
   * the screen recorder when asked: the returned session owns all of them.
   */
  startSession(bundleId: string, options: StartSessionOptions = {}): ProfilingSession {
    this.installProfilerOnDevice();

    if (options.recording && !this.supportsScreenRecording()) {
      Logger.warn(`Screen recording is not supported by this profiler, no video will be recorded`);
    }

    return new AndroidProfilingSession(
      bundleId,
      {
        pollCommand: this.getDeviceCommand(
          `${this.getDeviceProfilerPath()} pollPerformanceMeasures ${bundleId} ${POLLING_INTERVAL}`
        ),
        profilerName: CppProfilerName,
        cpuClockTick: this.getCpuClockTick(),
        ramPageSize: this.getRAMPageSize(),
        supportFPS: this.supportFPS(),
        withAtrace: this.withAtrace(),
      },
      this.supportsScreenRecording() ? options : { ...options, recording: undefined }
    );
  }

  public supportsScreenRecording(): boolean {
    return false;
  }

  // Disabling the warning because the method isn't implemented
  // oxlint-disable-next-line no-unused-vars
  public async stopApp(bundleId: string) {
    throw new Error("Method not implemented.");
  }

  /** Whether sessions trace `view` events with atrace (needed for FPS). */
  protected abstract withAtrace(): boolean;
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
