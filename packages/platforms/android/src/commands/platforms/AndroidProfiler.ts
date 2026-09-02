import { Logger } from "@lantern/logger";
import { execSync } from "child_process";
import { executeCommand } from "../shell";
import { getAbi } from "../getAbi";
import { detectCurrentAppBundleId } from "../detectCurrentAppBundleId";
import { CppProfilerName, UnixProfiler } from "./UnixProfiler";
import { refreshRateManager } from "../detectCurrentDeviceRefreshRate";
import { listAndroidDevices } from "../listDevices";
import { listInstalledApps } from "../listInstalledApps";
import { isDeviceProcessRunning } from "../isDeviceProcessRunning";
import { waitFor } from "../../utils/waitFor";

const STOP_APP_TIMEOUT = 5000;

export class AndroidProfiler extends UnixProfiler {
  installProfilerOnDevice(): void {
    super.installProfilerOnDevice();
    if (!refreshRateManager.isInitialized()) refreshRateManager.setRefreshRate();
  }

  assertSupported(): void {
    const sdkVersion = parseInt(executeCommand("adb shell getprop ro.build.version.sdk"), 10);

    if (sdkVersion < 24) {
      throw new Error(
        `Your Android version (sdk API level ${sdkVersion}) is not supported. Supported versions > 23.`
      );
    }
  }

  protected pushExecutable(binaryTmpPath: string): void {
    executeCommand(`adb push ${binaryTmpPath} ${this.getDeviceProfilerPath()}`);
    executeCommand(`adb shell chmod 755 ${this.getDeviceProfilerPath()}`);
  }

  public getDeviceProfilerPath(): string {
    return `/data/local/tmp/${CppProfilerName}`;
  }

  public getDeviceCommand(command: string): string {
    return `adb shell ${command}`;
  }

  protected getAbi(): string {
    return getAbi();
  }

  public detectCurrentBundleId(): string {
    return detectCurrentAppBundleId().bundleId;
  }

  public supportFPS(): boolean {
    return true;
  }

  protected withAtrace(): boolean {
    return true;
  }

  public supportsScreenRecording(): boolean {
    return true;
  }

  async stopApp(bundleId: string) {
    execSync(`adb shell am force-stop ${bundleId}`);
    try {
      await waitFor(() => !isDeviceProcessRunning(bundleId), {
        timeout: STOP_APP_TIMEOUT,
        checkInterval: 100,
      });
    } catch {
      Logger.warn(`${bundleId} is still running ${STOP_APP_TIMEOUT}ms after force-stop`);
    }
  }

  public detectDeviceRefreshRate(): number {
    return refreshRateManager.getRefreshRate();
  }

  public listApps() {
    return listInstalledApps();
  }

  public listDevices() {
    return listAndroidDevices();
  }
}
