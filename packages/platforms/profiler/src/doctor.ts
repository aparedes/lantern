import fs from "fs";
import {
  AndroidProfiler,
  MIN_ANDROID_SDK,
  adb,
  getAndroidProfilerBinaryPath,
  parseAdbDeviceStates,
} from "@lantern/android";
import { IOSProfiler, getIOSProfilerBinaryPath } from "@lantern/ios";
import { DeviceInfo, Platform } from "@lantern/types";
import { probeDevices } from "./probe";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  /** Stable identifier, e.g. `android.adb` or `ios.binary`. */
  id: string;
  platform: Platform;
  status: CheckStatus;
  message: string;
  /** What to do about a `warn` or `fail`. */
  fix?: string;
  /** The device the check is about, when it is about one. */
  device?: string;
}

/** What `lantern doctor` found. Bump `schemaVersion` on any breaking change. */
export interface DoctorReport {
  schemaVersion: 1;
  /** Whether a device of each platform can be profiled right now. */
  ready: Record<Platform, boolean>;
  /** The devices that passed every check. */
  devices: DeviceInfo[];
  checks: DoctorCheck[];
}

/** What the checks run against; overridden in tests. */
export interface DoctorEnvironment {
  hostPlatform: NodeJS.Platform;
  adb: (args: string[], options?: { serial?: string }) => string;
  androidBinaryPath: (abi: string) => string;
  iosBinaryPath: () => string;
  isExecutable: (path: string) => boolean;
  fileExists: (path: string) => boolean;
  listIOSDevices: () => Promise<DeviceInfo[]>;
}

const defaultEnvironment = (): DoctorEnvironment => ({
  hostPlatform: process.platform,
  adb,
  androidBinaryPath: getAndroidProfilerBinaryPath,
  iosBinaryPath: getIOSProfilerBinaryPath,
  isExecutable: (path) => {
    try {
      fs.accessSync(path, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  fileExists: fs.existsSync,
  listIOSDevices: () => probeDevices(new IOSProfiler()),
});

const firstLine = (output: string) => output.split(/\r\n|\n|\r/)[0].trim();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const ADB_STATE_FIXES: Partial<Record<string, string>> = {
  unauthorized: "Unlock the device and accept the USB debugging prompt",
  offline: "Reconnect the device, or restart adb with `adb kill-server`",
  "no permissions": "Fix the USB permissions for adb (udev rules on Linux)",
};

const checkAndroid = (env: DoctorEnvironment) => {
  const checks: DoctorCheck[] = [];
  const devices: DeviceInfo[] = [];

  let adbVersion: string;
  try {
    adbVersion = firstLine(env.adb(["version"]));
  } catch {
    checks.push({
      id: "android.adb",
      platform: "android",
      status: "fail",
      message: "adb is not available",
      fix: "Install the Android SDK platform-tools and put adb on your PATH",
    });

    return { checks, devices };
  }
  checks.push({ id: "android.adb", platform: "android", status: "ok", message: adbVersion });

  let states;
  try {
    states = parseAdbDeviceStates(env.adb(["devices"]));
  } catch (error) {
    checks.push({
      id: "android.devices",
      platform: "android",
      status: "fail",
      message: `adb devices failed: ${errorMessage(error)}`,
      fix: "Restart adb with `adb kill-server`",
    });

    return { checks, devices };
  }

  for (const { id, state } of states.filter(({ state }) => state !== "device")) {
    checks.push({
      id: "android.device",
      platform: "android",
      status: "warn",
      device: id,
      message: `${id} is ${state}`,
      fix: ADB_STATE_FIXES[state] ?? "Reconnect the device",
    });
  }

  const usable = states.filter(({ state }) => state === "device");
  if (usable.length === 0) {
    checks.push({
      id: "android.devices",
      platform: "android",
      status: "warn",
      message: "No Android device is connected",
      fix: "Connect a device with USB debugging enabled (Settings > Developer options), or start an emulator",
    });
  }

  for (const { id } of usable) {
    try {
      const sdk = parseInt(
        firstLine(env.adb(["shell", "getprop", "ro.build.version.sdk"], { serial: id })),
        10
      );
      if (!(sdk >= MIN_ANDROID_SDK)) {
        checks.push({
          id: "android.sdk",
          platform: "android",
          status: "fail",
          device: id,
          message: `${id} runs Android API level ${sdk}`,
          fix: `Use a device running Android 7.0 (API ${MIN_ANDROID_SDK}) or newer`,
        });
        continue;
      }

      const abi = firstLine(env.adb(["shell", "getprop", "ro.product.cpu.abi"], { serial: id }));
      if (!env.fileExists(env.androidBinaryPath(abi))) {
        checks.push({
          id: "android.abi",
          platform: "android",
          status: "fail",
          device: id,
          message: `No profiler binary is shipped for ${id}'s ABI (${abi})`,
          fix: "Use an arm64-v8a device or emulator (on Apple Silicon, arm64 emulator images)",
        });
        continue;
      }

      const model = firstLine(env.adb(["shell", "getprop", "ro.product.model"], { serial: id }));
      checks.push({
        id: "android.device",
        platform: "android",
        status: "ok",
        device: id,
        message: `${model || id} (${id}): API ${sdk}, ${abi}`,
      });
      devices.push({ id, name: model || id, platform: "android" });
    } catch (error) {
      checks.push({
        id: "android.device",
        platform: "android",
        status: "fail",
        device: id,
        message: `Could not query ${id}: ${errorMessage(error)}`,
        fix: "Unlock the device and reconnect it",
      });
    }
  }

  return { checks, devices };
};

const checkIOS = async (env: DoctorEnvironment) => {
  const checks: DoctorCheck[] = [];

  if (env.hostPlatform !== "darwin") {
    checks.push({
      id: "ios.host",
      platform: "ios",
      status: "skip",
      message: `iOS profiling needs a macOS host (this one runs ${env.hostPlatform})`,
    });

    return { checks, devices: [] };
  }

  const binaryPath = env.iosBinaryPath();
  if (!env.isExecutable(binaryPath)) {
    checks.push({
      id: "ios.binary",
      platform: "ios",
      status: "fail",
      message: `The iOS profiler binary is missing or not executable: ${binaryPath}`,
      fix: "Build it with packages/platforms/ios/rust-profiler/build_macos.sh, or set LANTERN_IOS_BINARY_PATH",
    });

    return { checks, devices: [] };
  }
  checks.push({ id: "ios.binary", platform: "ios", status: "ok", message: binaryPath });

  const devices = await env.listIOSDevices();
  if (devices.length === 0) {
    checks.push({
      id: "ios.devices",
      platform: "ios",
      status: "warn",
      message: "No iOS device is connected",
      fix: "Connect the device over USB, unlock it and trust this Mac, and enable Developer Mode (Settings > Privacy & Security)",
    });
  }
  for (const device of devices) {
    checks.push({
      id: "ios.device",
      platform: "ios",
      status: "ok",
      device: device.id,
      message: `${device.name} (${device.id})`,
      // Listing goes through usbmuxd only: profiling also needs the Developer Disk Image
      fix: "If profiling fails to start, mount the Developer Disk Image once (open the device in Xcode, or use devicectl)",
    });
  }

  return { checks, devices };
};

/**
 * Checks what profiling needs on this host, for both platforms: tooling, binaries, connected
 * devices and whether they are supported. Never throws: every problem is a check with a fix.
 */
export const runDoctor = async (
  overrides: Partial<DoctorEnvironment> = {}
): Promise<DoctorReport> => {
  const env = { ...defaultEnvironment(), ...overrides };
  const android = checkAndroid(env);
  const ios = await checkIOS(env).catch((error: unknown) => ({
    checks: [
      {
        id: "ios.devices",
        platform: "ios" as const,
        status: "fail" as const,
        message: `Could not list iOS devices: ${errorMessage(error)}`,
      },
    ],
    devices: [],
  }));

  return {
    schemaVersion: 1,
    ready: { android: android.devices.length > 0, ios: ios.devices.length > 0 },
    devices: [...android.devices, ...ios.devices],
    checks: [...android.checks, ...ios.checks],
  };
};

/** Every connected device, of both platforms (or of `platform` only), without picking one. */
export const listAllDevices = async (platform?: Platform): Promise<DeviceInfo[]> => {
  const android = platform === "ios" ? [] : await probeDevices(new AndroidProfiler());
  const ios = platform === "android" ? [] : await probeDevices(new IOSProfiler());

  return [...android, ...ios];
};
