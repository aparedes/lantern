import { describe, expect, it } from "bun:test";
import { DeviceInfo } from "@lantern/types";
import { DeviceSelectionError, selectDevice } from "../device";

const pixel: DeviceInfo = { id: "R58M12345Z", name: "Pixel 7", platform: "android" };
const emulator: DeviceInfo = { id: "emulator-5554", name: "emulator-5554", platform: "android" };
const options = { platformName: "Android", idLabel: "serial" };

describe("selectDevice", () => {
  it("picks the only connected device", () => {
    expect(selectDevice([pixel], options)).toBe(pixel);
  });

  it("picks the requested device when it is connected", () => {
    expect(selectDevice([pixel, emulator], { ...options, requested: "emulator-5554" })).toBe(
      emulator
    );
  });

  it("rejects a requested device that is not connected, naming the connected ones", () => {
    expect(() => selectDevice([pixel], { ...options, requested: "nope" })).toThrow(
      new DeviceSelectionError('Unknown Android device "nope" (connected: R58M12345Z)')
    );
    expect(() => selectDevice([], { ...options, requested: "nope" })).toThrow(
      'Unknown Android device "nope" (no device connected)'
    );
  });

  it("asks for a device when none is connected", () => {
    expect(() => selectDevice([], options)).toThrow(
      new DeviceSelectionError("No Android device connected")
    );
  });

  it("asks for --device when several are connected", () => {
    expect(() => selectDevice([pixel, emulator], { ...options, idLabel: "serial" })).toThrow(
      new DeviceSelectionError(
        "Several Android devices are connected (R58M12345Z, emulator-5554): pass --device <serial>"
      )
    );
  });
});
