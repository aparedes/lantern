import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { DeviceInfo } from "@lantern/types";
import { AndroidProfiler } from "@lantern/android";
import { IOSProfiler } from "@lantern/ios";
import { PlatformResolutionError, createProfiler, resolvePlatform } from "../index";

const originalPlatformEnv = process.env.PLATFORM;

const androidDevice: DeviceInfo = { id: "R58M12345Z", name: "Pixel 7", platform: "android" };
const iosDevice: DeviceInfo = {
  id: "00008130-000",
  name: "iPhone",
  platform: "ios",
  model: "iPhone16,1",
};

const probe = (android: DeviceInfo[], ios: DeviceInfo[]) => ({
  android: async () => android,
  ios: async () => ios,
});

beforeEach(() => {
  delete process.env.PLATFORM;
});

afterAll(() => {
  if (originalPlatformEnv === undefined) {
    delete process.env.PLATFORM;
  } else {
    process.env.PLATFORM = originalPlatformEnv;
  }
});

describe("resolvePlatform", () => {
  it("gives priority to the flag", async () => {
    process.env.PLATFORM = "android";

    expect(await resolvePlatform("ios", probe([androidDevice], []))).toBe("ios");
  });

  it("rejects an unknown flag", async () => {
    await expect(resolvePlatform("windows", probe([androidDevice], []))).rejects.toThrow(
      PlatformResolutionError
    );
  });

  it("falls back to the PLATFORM env var", async () => {
    process.env.PLATFORM = "ios";

    expect(await resolvePlatform(undefined, probe([androidDevice], []))).toBe("ios");
  });

  it("auto-detects an android device", async () => {
    expect(await resolvePlatform(undefined, probe([androidDevice], []))).toBe("android");
  });

  it("auto-detects an ios device", async () => {
    expect(await resolvePlatform(undefined, probe([], [iosDevice]))).toBe("ios");
  });

  it("asks for --platform when both platforms have a device", async () => {
    await expect(resolvePlatform(undefined, probe([androidDevice], [iosDevice]))).rejects.toThrow(
      /--platform/
    );
  });

  it("asks the user to connect a device when none is found", async () => {
    await expect(resolvePlatform(undefined, probe([], []))).rejects.toThrow(/No device found/);
  });

  it("releases the throwaway profilers it probes with", async () => {
    const dispose = spyOn(IOSProfiler.prototype, "dispose");
    const listDevices = spyOn(IOSProfiler.prototype, "listDevices").mockImplementation(async () => [
      iosDevice,
    ]);
    const androidListDevices = spyOn(AndroidProfiler.prototype, "listDevices").mockImplementation(
      async () => []
    );
    try {
      expect(await resolvePlatform(undefined)).toBe("ios");
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
      listDevices.mockRestore();
      androidListDevices.mockRestore();
    }
  });
});

describe("createProfiler", () => {
  it("hands the --device value to the platform's profiler", async () => {
    const android = createProfiler("android", "R58M12345Z");
    expect(android).toBeInstanceOf(AndroidProfiler);
    expect((android as AndroidProfiler).requestedDevice).toBe("R58M12345Z");

    const ios = createProfiler("ios", "00008130-000");
    expect(ios).toBeInstanceOf(IOSProfiler);
    expect((ios as IOSProfiler).requestedDevice).toBe("00008130-000");

    const self = createProfiler("lantern", "R58M12345Z");
    expect(self).toBeInstanceOf(AndroidProfiler);
    expect(await self.detectCurrentBundleId()).toBe("lantern-android-profiler");
  });

  it("leaves the device to be resolved when none was asked for", () => {
    expect((createProfiler("android") as AndroidProfiler).requestedDevice).toBeUndefined();
  });
});
