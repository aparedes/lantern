import {
  detectCurrentDeviceRefreshRate,
  detectRefreshRateOrDefault,
} from "../detectCurrentDeviceRefreshRate";
import fs from "fs";
import { describe, it, expect, afterAll, spyOn, mock } from "bun:test";
import * as adbModule from "../adb";

const sampleOutput = fs.readFileSync(`${__dirname}/dumpsys-display.txt`, "utf-8");
const sampleOutput2 = fs.readFileSync(`${__dirname}/dumpsys-display120.txt`, "utf-8");

const adbSpy = spyOn(adbModule, "adb");

describe("detectCurrentDeviceRefreshRate", () => {
  it("retrieves correctly device refresh rate of a basic 60fps device", () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["shell", 'dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"']);

      return sampleOutput;
    });

    expect(detectCurrentDeviceRefreshRate()).toEqual(60);
  });

  it("retrieves correctly device refresh rate of a 120fps pixel device", () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["shell", 'dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"']);

      return sampleOutput2;
    });

    expect(detectCurrentDeviceRefreshRate()).toEqual(120);
  });

  it("rounds a fractional refresh rate to the nearest integer", () => {
    adbSpy.mockImplementation(() => "DisplayDeviceInfo{..., fps=59.94, ...}");

    expect(detectCurrentDeviceRefreshRate()).toEqual(60);
  });

  it("throws an error in case it couldn't find it", () => {
    adbSpy.mockImplementation(() => "");
    expect(detectCurrentDeviceRefreshRate).toThrow();
  });
});

describe("detectRefreshRateOrDefault", () => {
  it("returns the detected refresh rate", () => {
    adbSpy.mockImplementation(() => sampleOutput2);

    expect(detectRefreshRateOrDefault()).toEqual(120);
  });

  it("falls back to 60 Hz when the detection throws", () => {
    adbSpy.mockImplementation(() => {
      throw new Error("no device");
    });

    expect(detectRefreshRateOrDefault()).toEqual(60);
  });
});

afterAll(() => mock.restore());
