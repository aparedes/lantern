import { describe, expect, it } from "bun:test";
import { DeviceInfo } from "@lantern/types";
import { DoctorEnvironment, runDoctor } from "../doctor";

interface FakeDevice {
  id: string;
  state?: string;
  sdk?: string;
  abi?: string;
  model?: string;
}

/** An adb that knows `devices`, `version` and the three getprops the doctor reads. */
const fakeAdb =
  (devices: FakeDevice[]): DoctorEnvironment["adb"] =>
  (args, { serial } = {}) => {
    if (args[0] === "version") return "Android Debug Bridge version 1.0.41\nVersion 35.0.2\n";
    if (args[0] === "devices") {
      return [
        "List of devices attached",
        ...devices.map(({ id, state = "device" }) => `${id}\t${state}`),
        "",
      ].join("\n");
    }

    const device = devices.find(({ id }) => id === serial);
    if (!device) throw new Error(`device '${serial}' not found`);
    const property = args.at(-1);
    if (property === "ro.build.version.sdk") return `${device.sdk ?? "34"}\n`;
    if (property === "ro.product.cpu.abi") return `${device.abi ?? "arm64-v8a"}\n`;
    if (property === "ro.product.model") return `${device.model ?? "Pixel 7"}\n`;
    throw new Error(`unexpected adb ${args.join(" ")}`);
  };

const environment = (overrides: Partial<DoctorEnvironment> = {}): Partial<DoctorEnvironment> => ({
  hostPlatform: "darwin",
  adb: fakeAdb([]),
  androidBinaryPath: (abi) => `/bin/lantern-android-profiler-${abi}`,
  fileExists: (path) => path === "/bin/lantern-android-profiler-arm64-v8a",
  iosBinaryPath: () => "/bin/lantern-ios-profiler",
  isExecutable: () => true,
  listIOSDevices: async () => [],
  ...overrides,
});

const iPhone: DeviceInfo = { id: "00008110-000A", name: "iPhone 15", platform: "ios" };

describe("runDoctor", () => {
  it("is ready on both platforms with a supported device of each", async () => {
    const report = await runDoctor(
      environment({
        adb: fakeAdb([{ id: "R58M12345Z" }]),
        listIOSDevices: async () => [iPhone],
      })
    );

    expect(report.ready).toEqual({ android: true, ios: true });
    expect(report.devices).toEqual([
      { id: "R58M12345Z", name: "Pixel 7", platform: "android" },
      iPhone,
    ]);
    expect(report.checks.map(({ id, status }) => [id, status])).toEqual([
      ["android.adb", "ok"],
      ["android.device", "ok"],
      ["ios.binary", "ok"],
      ["ios.device", "ok"],
    ]);
    expect(report.checks[1].message).toBe("Pixel 7 (R58M12345Z): API 34, arm64-v8a");
  });

  it("stops the Android checks with a fix when adb is missing", async () => {
    const report = await runDoctor(
      environment({
        adb: () => {
          throw new Error("spawnSync adb ENOENT");
        },
      })
    );

    expect(report.ready.android).toBe(false);
    expect(report.checks.filter(({ platform }) => platform === "android")).toEqual([
      {
        id: "android.adb",
        platform: "android",
        status: "fail",
        message: "adb is not available",
        fix: "Install the Android SDK platform-tools and put adb on your PATH",
      },
    ]);
  });

  it("explains each unusable Android device, and the lack of a usable one", async () => {
    const report = await runDoctor(
      environment({
        adb: fakeAdb([
          { id: "unauth", state: "unauthorized" },
          { id: "gone", state: "offline" },
          { id: "old", sdk: "23" },
          { id: "x86", abi: "x86_64" },
        ]),
      })
    );

    const android = report.checks.filter(({ platform }) => platform === "android");
    expect(android.map(({ id, status, device }) => [id, status, device])).toEqual([
      ["android.adb", "ok", undefined],
      ["android.device", "warn", "unauth"],
      ["android.device", "warn", "gone"],
      ["android.sdk", "fail", "old"],
      ["android.abi", "fail", "x86"],
    ]);
    expect(android[1].fix).toBe("Unlock the device and accept the USB debugging prompt");
    expect(android[3].fix).toBe("Use a device running Android 7.0 (API 24) or newer");
    expect(report.ready.android).toBe(false);
  });

  it("asks to connect an Android device when adb sees none", async () => {
    const report = await runDoctor(environment());

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "android.devices", status: "warn" })
    );
  });

  it("skips iOS on a host that is not macOS", async () => {
    const report = await runDoctor(
      environment({
        hostPlatform: "linux",
        listIOSDevices: async () => {
          throw new Error("must not be called");
        },
      })
    );

    expect(report.ready.ios).toBe(false);
    expect(report.checks.filter(({ platform }) => platform === "ios")).toEqual([
      {
        id: "ios.host",
        platform: "ios",
        status: "skip",
        message: "iOS profiling needs a macOS host (this one runs linux)",
      },
    ]);
  });

  it("reports a missing iOS binary, then no device, with their fixes", async () => {
    const missing = await runDoctor(environment({ isExecutable: () => false }));
    expect(missing.checks.at(-1)).toMatchObject({ id: "ios.binary", status: "fail" });
    expect(missing.checks.at(-1)?.fix).toContain("build_macos.sh");

    const none = await runDoctor(environment());
    expect(none.checks.at(-1)).toMatchObject({ id: "ios.devices", status: "warn" });
    expect(none.checks.at(-1)?.fix).toContain("Developer Mode");
  });

  it("never throws, even when listing iOS devices does", async () => {
    const report = await runDoctor(
      environment({
        listIOSDevices: async () => {
          throw new Error("usbmuxd is not running");
        },
      })
    );

    expect(report.ready.ios).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({
      id: "ios.devices",
      status: "fail",
      message: "Could not list iOS devices: usbmuxd is not running",
    });
  });
});
