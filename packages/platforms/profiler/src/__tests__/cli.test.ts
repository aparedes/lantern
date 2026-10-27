import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { LogLevel, Logger } from "@lantern/logger";
import { DeviceInfo } from "@lantern/types";
import * as profilerModule from "../index";
import { applyCommonOptions, registerCommonOptions } from "../cli";
import { DeviceSelectionError, PlatformResolutionError } from "../index";

const device: DeviceInfo = { id: "R58M12345Z", name: "Pixel 7", platform: "android" };

/** Thrown by the `process.exit` spy so that the test process survives the call. */
class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
  throw new ExitSentinel(code);
}) as unknown as typeof process.exit);
const setLogLevel = spyOn(Logger, "setLogLevel").mockImplementation(() => {});
const error = spyOn(Logger, "error").mockImplementation(() => {});
const info = spyOn(Logger, "info").mockImplementation(() => {});
const select = spyOn(profilerModule, "selectPlatformAndDevice");

beforeEach(() => {
  select.mockResolvedValue({ platform: "android", device });
});

afterEach(() => {
  exit.mockClear();
  setLogLevel.mockClear();
  error.mockClear();
  info.mockClear();
  select.mockClear();
});

afterAll(() => mock.restore());

describe("registerCommonOptions", () => {
  it("adds --platform, --device and --logLevel with their choices, and chains", () => {
    const command = new Command("measure");

    expect(registerCommonOptions(command)).toBe(command);

    const byName = Object.fromEntries(command.options.map((option) => [option.long, option]));
    expect(Object.keys(byName)).toEqual(["--platform", "--device", "--logLevel"]);
    expect(byName["--platform"].argChoices).toEqual(["android", "ios"]);
    expect(byName["--device"].argChoices).toBeUndefined();
    expect(byName["--logLevel"].argChoices).toEqual([
      "silent",
      "error",
      "warn",
      "success",
      "info",
      "debug",
      "trace",
    ]);
  });

  it("parses the three options into the action's options object", async () => {
    let received: unknown;
    const program = new Command("lantern").exitOverride();
    registerCommonOptions(program.command("measure")).action((options) => {
      received = options;
    });

    await program.parseAsync(
      ["measure", "--platform", "ios", "--device", "UDID", "--logLevel", "debug"],
      { from: "user" }
    );

    expect(received).toEqual({ platform: "ios", device: "UDID", logLevel: "debug" });
  });
});

describe("applyCommonOptions", () => {
  it("applies the log level before resolving the platform and device, then logs the selection", async () => {
    const order: string[] = [];
    setLogLevel.mockImplementationOnce(() => {
      order.push("logLevel");
    });
    select.mockImplementationOnce(async () => {
      order.push("select");

      return { platform: "android", device };
    });

    const selection = await applyCommonOptions({
      platform: "android",
      device: "R58M12345Z",
      logLevel: "debug",
    });

    expect(order).toEqual(["logLevel", "select"]);
    expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    expect(select).toHaveBeenCalledWith("android", "R58M12345Z");
    expect(selection).toEqual({ platform: "android", device });
    expect(info).toHaveBeenCalledWith("Using android device Pixel 7 (R58M12345Z)");
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves the log level alone when --logLevel is not passed", async () => {
    await applyCommonOptions({});

    expect(setLogLevel).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(undefined, undefined);
  });

  it("rejects with a platform resolution error, leaving printing and exiting to the CLI", async () => {
    const failure = new PlatformResolutionError("NO_DEVICE", "No device found");
    select.mockRejectedValueOnce(failure);

    await expect(applyCommonOptions({})).rejects.toBe(failure);

    expect(failure.code).toBe("NO_DEVICE");
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rejects with a device selection error, leaving printing and exiting to the CLI", async () => {
    const failure = new DeviceSelectionError(
      "AMBIGUOUS_DEVICE",
      "Several Android devices are connected (a, b): pass --device <serial>"
    );
    select.mockRejectedValueOnce(failure);

    await expect(applyCommonOptions({ device: "c" })).rejects.toBe(failure);

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rethrows any other error untouched", async () => {
    const failure = new Error("adb crashed");
    select.mockRejectedValueOnce(failure);

    await expect(applyCommonOptions({})).rejects.toBe(failure);

    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
