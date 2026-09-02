import { AndroidProfiler, LanternSelfProfiler } from "@lantern/android";
import { IOSProfiler } from "@lantern/ios";
import { DeviceInfo, Platform, Profiler } from "@lantern/types";

/** `lantern` is the self-profiler used to measure the CLI itself; not user-facing. */
export type ProfilerPlatform = Platform | "lantern";
export const PLATFORMS: readonly Platform[] = ["android", "ios"];

let selected: ProfilerPlatform | undefined;
let instance: Profiler | undefined;

const platformFromEnv = (): ProfilerPlatform | undefined => {
  const value = process.env.PLATFORM;

  return value === "ios" || value === "android" || value === "lantern" ? value : undefined;
};

const create = (platform: ProfilerPlatform): Profiler => {
  switch (platform) {
    case "ios":
      return new IOSProfiler();
    case "lantern":
      return new LanternSelfProfiler();
    default:
      return new AndroidProfiler();
  }
};

/** Fixes the platform for this process. Must run before the first profiler call. */
export const setPlatform = (platform: ProfilerPlatform) => {
  if (instance && selected !== platform) {
    throw new Error(`Platform already set to ${selected}; cannot switch to ${platform}`);
  }
  selected = platform;
};

export const getPlatform = (): Platform => {
  const platform = selected ?? platformFromEnv() ?? "android";

  return platform === "ios" ? "ios" : "android";
};

const get = (): Profiler => (instance ??= create(selected ?? platformFromEnv() ?? "android"));

/**
 * Delegates lazily so `--platform` can be parsed before any platform code runs. A plain object
 * (not a Proxy) so tests can keep `spyOn(profiler, "installProfilerOnDevice")`.
 */
export const profiler: Profiler = {
  startSession: (bundleId, options) => get().startSession(bundleId, options),
  detectCurrentBundleId: () => get().detectCurrentBundleId(),
  installProfilerOnDevice: () => get().installProfilerOnDevice(),
  supportsScreenRecording: () => get().supportsScreenRecording(),
  stopApp: (bundleId) => get().stopApp(bundleId),
  detectDeviceRefreshRate: () => get().detectDeviceRefreshRate(),
  listApps: () => get().listApps(),
  listDevices: () => get().listDevices(),
};

export class PlatformResolutionError extends Error {}

/**
 * `--platform` > `PLATFORM` env > probing connected devices. Exactly one platform with a device
 * wins; both or none is an error that tells the user to pass `--platform`.
 */
export const resolvePlatform = (
  flag: string | undefined,
  probe: { android: () => DeviceInfo[]; ios: () => DeviceInfo[] } = {
    android: () => new AndroidProfiler().listDevices(),
    ios: () => new IOSProfiler().listDevices(),
  }
): ProfilerPlatform => {
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

  const android = probe.android();
  const ios = probe.ios();

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
