import { detectCurrentAppBundleId } from "../detectCurrentAppBundleId";
import fs from "fs";
import { describe, it, expect, afterAll, spyOn, mock } from "bun:test";
import * as adbModule from "../adb";

const sampleOutput = fs.readFileSync(`${__dirname}/dumpsys-window.txt`, "utf-8");

const sampleOutputWithoutDollars = `
mSurface=Surface(name=com.example.staging/com.example.MainActivity)/@0x993d3ae
mSurface=Surface(name=com.sec.android.app.launcher/com.sec.android.app.launcher.activities.LauncherActivity)/@0x469a915`;

const adbSpy = spyOn(adbModule, "adb");

describe("detectCurrentAppBundleId", () => {
  it("retrieves correctly bundle id and app activity when result match 'name=appId/appActivity$'", () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["shell", "dumpsys", "window", "windows"]);

      return sampleOutput;
    });

    expect(detectCurrentAppBundleId()).toEqual({
      appActivity: "com.twitter.app.main.MainActivity",
      bundleId: "com.twitter.android",
    });
  });

  it("retrieves correctly bundle id and app activity when result match 'name=appId/appActivity)'", () => {
    adbSpy.mockImplementation((args) => {
      expect(args).toEqual(["shell", "dumpsys", "window", "windows"]);

      return sampleOutputWithoutDollars;
    });

    expect(detectCurrentAppBundleId()).toEqual({
      bundleId: "com.example.staging",
      appActivity: "com.example.MainActivity",
    });
  });

  it("targets the given device", () => {
    adbSpy.mockImplementation((args, options) => {
      expect(options).toEqual({ serial: "R58M12345Z" });

      return sampleOutputWithoutDollars;
    });

    expect(detectCurrentAppBundleId("R58M12345Z").bundleId).toBe("com.example.staging");
  });

  it("throws an error in case it couldn't find them", () => {
    adbSpy.mockImplementation(() => "");
    expect(detectCurrentAppBundleId).toThrowError();
  });
});

afterAll(() => mock.restore());
