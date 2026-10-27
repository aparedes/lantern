import { describe, expect, it } from "bun:test";
import { formatApps, formatDevices } from "../command";
import { formatDoctorReport } from "../doctor";

describe("formatDevices", () => {
  it("lists one device per line, with its platform and model", () => {
    expect(
      formatDevices([
        { id: "R58M12345Z", name: "Pixel 7", platform: "android" },
        { id: "00008110-000A", name: "iPhone 15", platform: "ios", model: "iPhone15,4" },
      ])
    ).toBe(
      [
        "android  R58M12345Z                 Pixel 7",
        "ios      00008110-000A              iPhone 15 (iPhone15,4)",
      ].join("\n")
    );
  });

  it("points to doctor when nothing is connected", () => {
    expect(formatDevices([])).toContain("lantern doctor");
  });
});

describe("formatApps", () => {
  it("shows the name only when it differs from the bundle id, and flags running apps", () => {
    expect(
      formatApps([
        { bundleId: "com.example", name: "Example", isRunning: true },
        { bundleId: "com.other", name: "com.other" },
      ])
    ).toBe("com.example  Example  (running)\ncom.other");
  });
});

describe("formatDoctorReport", () => {
  it("prints each check, the fixes of the failing ones, and what is ready", () => {
    expect(
      formatDoctorReport({
        schemaVersion: 1,
        ready: { android: true, ios: false },
        devices: [],
        checks: [
          { id: "android.adb", platform: "android", status: "ok", message: "adb 1.0.41" },
          {
            id: "ios.devices",
            platform: "ios",
            status: "warn",
            message: "No iOS device is connected",
            fix: "Connect the device over USB",
          },
        ],
      })
    ).toBe(
      [
        "✔ android  adb 1.0.41",
        "⚠ ios      No iOS device is connected",
        "  → Connect the device over USB",
        "",
        "Ready to profile: android",
      ].join("\n")
    );
  });
});
