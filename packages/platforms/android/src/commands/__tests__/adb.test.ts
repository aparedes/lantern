import * as childProcess from "child_process";
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { adb, adbArgs, adbAsync, adbIgnoringOutput } from "../adb";

Logger.setLogLevel(LogLevel.SILENT);

const execFileSync = spyOn(childProcess, "execFileSync");
const spawn = spyOn(childProcess, "spawn");

afterEach(() => {
  execFileSync.mockReset();
  spawn.mockReset();
});
afterAll(() => mock.restore());

describe("adbArgs", () => {
  it("targets the device with -s when a serial is given", () => {
    expect(adbArgs(["shell", "ls"], "R58M12345Z")).toEqual(["-s", "R58M12345Z", "shell", "ls"]);
    expect(adbArgs(["devices", "-l"])).toEqual(["devices", "-l"]);
  });
});

describe("adb", () => {
  it("runs adb without a shell and returns its output", () => {
    execFileSync.mockImplementation(
      (() => "arm64-v8a\n") as unknown as typeof childProcess.execFileSync
    );

    expect(adb(["shell", "getprop", "ro.product.cpu.abi"], { serial: "R58M12345Z" })).toBe(
      "arm64-v8a\n"
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "adb",
      ["-s", "R58M12345Z", "shell", "getprop", "ro.product.cpu.abi"],
      expect.objectContaining({ stdio: "pipe", encoding: "utf8" })
    );
  });

  it("passes a value with spaces through as one argument", () => {
    execFileSync.mockImplementation((() => "") as unknown as typeof childProcess.execFileSync);
    const pipeline = 'dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"';

    adb(["shell", pipeline]);

    expect(execFileSync.mock.calls[0][1]).toEqual(["shell", pipeline]);
  });

  it("rethrows a failure after logging its stderr", () => {
    const debug = spyOn(Logger, "debug");
    const failure = Object.assign(new Error("Command failed"), { stderr: "error: no devices" });
    execFileSync.mockImplementation(() => {
      throw failure;
    });

    expect(() => adb(["shell", "ls"])).toThrow(failure);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("error: no devices"));
    debug.mockRestore();
  });
});

describe("adbIgnoringOutput", () => {
  it("discards the output", () => {
    execFileSync.mockImplementation((() => "") as unknown as typeof childProcess.execFileSync);

    adbIgnoringOutput(["shell", "atrace", "--async_stop"], { serial: "S" });

    expect(execFileSync).toHaveBeenCalledWith(
      "adb",
      ["-s", "S", "shell", "atrace", "--async_stop"],
      {
        stdio: "ignore",
      }
    );
  });
});

describe("adbAsync", () => {
  it("spawns adb with the serial first", () => {
    const child = Object.assign(new (require("events").EventEmitter)(), {
      stdout: null,
      stderr: null,
    });
    spawn.mockImplementation((() => child) as unknown as typeof childProcess.spawn);

    expect(adbAsync(["shell", "screenrecord"], { serial: "S" })).toBe(child);
    expect(spawn).toHaveBeenCalledWith("adb", ["-s", "S", "shell", "screenrecord"]);
  });
});
