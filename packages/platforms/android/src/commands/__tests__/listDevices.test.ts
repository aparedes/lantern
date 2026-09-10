import { describe, it, expect, afterAll, spyOn, mock } from "bun:test";
import { listAndroidDevices, parseAdbDevices } from "../listDevices";
import * as adbModule from "../adb";

const adbSpy = spyOn(adbModule, "adb");

describe("parseAdbDevices", () => {
  it("returns no device when adb only prints its header", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });

  it("ignores devices that are not in the `device` state", () => {
    const output = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 device:emu64a transport_id:1
1234567890             unauthorized usb:12345
`;

    expect(parseAdbDevices(output)).toEqual([
      { id: "emulator-5554", name: "emulator-5554", platform: "android" },
    ]);
  });

  it("uses the model as a human readable name", () => {
    const output = `List of devices attached
R58M12345Z             device usb:1-1 product:d2q model:Pixel_7 device:d2q transport_id:2
`;

    expect(parseAdbDevices(output)).toEqual([
      { id: "R58M12345Z", name: "Pixel 7", platform: "android" },
    ]);
  });
});

describe("listAndroidDevices", () => {
  it("returns an empty list when adb is missing or fails", () => {
    adbSpy.mockImplementation(() => {
      throw new Error("command not found: adb");
    });

    expect(listAndroidDevices()).toEqual([]);
  });

  it("parses the output of `adb devices -l`", () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["devices", "-l"]);

      return `List of devices attached
R58M12345Z             device usb:1-1 model:Pixel_7 device:d2q transport_id:2
`;
    });

    expect(listAndroidDevices()).toEqual([
      { id: "R58M12345Z", name: "Pixel 7", platform: "android" },
    ]);
  });
});

afterAll(() => mock.restore());
