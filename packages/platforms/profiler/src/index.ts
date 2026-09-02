import { AndroidProfiler } from "@lantern/android";
import { IOSProfiler } from "@lantern/ios";
import { DeviceInfo, Platform, Profiler } from "@lantern/types";
import { DeviceSelectionError } from "@lantern/profiler-protocol";

/** `lantern` is the self-profiler used to measure the CLI itself; not user-facing. */
export type ProfilerPlatform = Platform | "lantern";
export const PLATFORMS: readonly Platform[] = ["android", "ios"];

let selected: ProfilerPlatform | undefined;
/** The `--device` serial / UDID, if any. */
let selectedDevice: string | undefined;
let instance: Profiler | undefined;

const platformFromEnv = (): ProfilerPlatform | undefined => {
  const value = process.env.PLATFORM;

  return value === "ios" || value === "android" || value === "lantern" ? value : undefined;
};

/** `device` is the `--device` value: an adb serial on Android, a UDID on iOS. */
export const createProfiler = (platform: ProfilerPlatform, device?: string): Profiler => {
  switch (platform) {
    case "ios":
      return new IOSProfiler({ udid: device });
    case "lantern":
      return new AndroidProfiler({ serial: device, selfProfiling: true });
    default:
      return new AndroidProfiler({ serial: device });
  }
};

export interface PlatformOptions {
  /** Serial (Android) or UDID (iOS) of the device to use, when several are connected. */
  device?: string;
}

/** Fixes the platform (and device) for this process. Must run before the first profiler call. */
export const setPlatform = (platform: ProfilerPlatform, { device }: PlatformOptions = {}) => {
  if (instance && (selected !== platform || selectedDevice !== device)) {
    throw new Error(
      `Platform already set to ${selected}${selectedDevice ? ` (device ${selectedDevice})` : ""}; cannot switch to ${platform}${device ? ` (device ${device})` : ""}`
    );
  }
  selected = platform;
  selectedDevice = device;
};

export const getPlatform = (): Platform => {
  const platform = selected ?? platformFromEnv() ?? "android";

  return platform === "ios" ? "ios" : "android";
};

const get = (): Profiler =>
  (instance ??= createProfiler(selected ?? platformFromEnv() ?? "android", selectedDevice));

/**
 * Delegates lazily so `--platform` can be parsed before any platform code runs. A plain object
 * (not a Proxy) so tests can keep `spyOn(profiler, "installProfilerOnDevice")`.
 */
export const profiler: Profiler = {
  startSession: (bundleId, options) => get().startSession(bundleId, options),
  resolveDevice: () => get().resolveDevice(),
  detectCurrentBundleId: () => get().detectCurrentBundleId(),
  installProfilerOnDevice: () => get().installProfilerOnDevice(),
  supportsScreenRecording: () => get().supportsScreenRecording(),
  stopApp: (bundleId) => get().stopApp(bundleId),
  detectDeviceRefreshRate: () => get().detectDeviceRefreshRate(),
  listApps: () => get().listApps(),
  listDevices: () => get().listDevices(),
  // Nothing to release when no platform profiler was ever created
  dispose: () => instance?.dispose(),
};

export class PlatformResolutionError extends Error {}
export { DeviceSelectionError };

/**
 * Applies `--platform` / `--device` and checks the device up front, so that a wrong or ambiguous
 * `--device` is reported before anything (a server, a test run) starts. Both error classes carry
 * a message meant for the user.
 */
export const selectPlatformAndDevice = async (
  platformFlag: string | undefined,
  device?: string
): Promise<{ platform: ProfilerPlatform; device: DeviceInfo }> => {
  const platform = await resolvePlatform(platformFlag);
  setPlatform(platform, { device });

  return { platform, device: await profiler.resolveDevice() };
};

/** Lists one platform's devices with a throwaway profiler, released right after. */
const probeDevices = async (platformProfiler: Profiler): Promise<DeviceInfo[]> => {
  try {
    return await platformProfiler.listDevices();
  } finally {
    // The iOS profiler keeps a `serve` process alive otherwise
    platformProfiler.dispose();
  }
};

export interface PlatformProbe {
  android: () => Promise<DeviceInfo[]>;
  ios: () => Promise<DeviceInfo[]>;
}

/**
 * `--platform` > `PLATFORM` env > probing connected devices. Exactly one platform with a device
 * wins; both or none is an error that tells the user to pass `--platform`.
 */
export const resolvePlatform = async (
  flag: string | undefined,
  probe: PlatformProbe = {
    android: () => probeDevices(new AndroidProfiler()),
    ios: () => probeDevices(new IOSProfiler()),
  }
): Promise<ProfilerPlatform> => {
  if (flag !== undefined) {
    if (!PLATFORMS.includes(flag as Platform)) {
      throw new PlatformResolutionError(
        `Unknown --platform "${flag}" (expected ${PLATFORMS.join(" or ")})`
      );
    }

    return flag as Platform;
  }

  const fromEnv = platformFromEnv();
  if (fromEnv) return fromEnv;

  const android = await probe.android();
  const ios = await probe.ios();

  if (android.length > 0 && ios.length === 0) return "android";
  if (ios.length > 0 && android.length === 0) return "ios";
  if (android.length === 0 && ios.length === 0) {
    throw new PlatformResolutionError(
      "No device found. Connect an Android device (adb) or an iOS device over USB, or pass --platform android|ios"
    );
  }

  throw new PlatformResolutionError(
    `Both an Android device (${android.map((d) => d.name).join(", ")}) and an iOS device (${ios
      .map((d) => d.name)
      .join(", ")}) are connected: pass --platform android|ios`
  );
};

// TODO move this to a separate package
export { waitFor } from "@lantern/android";
export { disposeAllSessions, installSignalHandlers } from "@lantern/profiler-protocol";
export { applyCommonOptions, registerCommonOptions } from "./cli";
export type { CommonOptions } from "./cli";
