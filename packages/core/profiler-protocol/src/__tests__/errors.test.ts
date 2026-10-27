import { describe, expect, it } from "bun:test";
import { DeviceSelectionError } from "../device";
import { ERROR_CODES, LanternError, exitCodeFor, toLanternError } from "../errors";
import { ServeRequestError } from "../serve";

describe("LanternError", () => {
  it("carries its code, details and cause", () => {
    const cause = new Error("adb died");
    const error = new LanternError("NO_MEASURES", "No measures", {
      details: { bundleId: "com.example" },
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NO_MEASURES");
    expect(error.message).toBe("No measures");
    expect(error.details).toEqual({ bundleId: "com.example" });
    expect(error.cause).toBe(cause);
  });

  it("is the base class of DeviceSelectionError", () => {
    const error = new DeviceSelectionError("NO_DEVICE", "No Android device connected");

    expect(error).toBeInstanceOf(LanternError);
    expect(error.code).toBe("NO_DEVICE");
  });
});

describe("toLanternError", () => {
  it("returns a LanternError untouched", () => {
    const error = new LanternError("APP_NOT_FOUND", "nope");

    expect(toLanternError(error)).toBe(error);
  });

  it("maps a known serve code and keeps it as the platform code", () => {
    const error = toLanternError(new ServeRequestError("APP_NOT_FOUND", "com.x is not installed"));

    expect(error.code).toBe("APP_NOT_FOUND");
    expect(error.message).toBe("com.x is not installed");
    expect(error.details).toEqual({ platformCode: "APP_NOT_FOUND" });
  });

  it("keeps an unknown serve code as the platform code of an INTERNAL error", () => {
    const error = toLanternError(new ServeRequestError("BUSY", "a poll is running"));

    expect(error.code).toBe("INTERNAL");
    expect(error.details).toEqual({ platformCode: "BUSY" });
  });

  it("wraps anything else as INTERNAL", () => {
    expect(toLanternError(new Error("boom"))).toMatchObject({ code: "INTERNAL", message: "boom" });
    expect(toLanternError("plain string")).toMatchObject({
      code: "INTERNAL",
      message: "plain string",
    });
  });
});

describe("exitCodeFor", () => {
  it("maps usage, setup and threshold failures to their own codes", () => {
    expect(exitCodeFor("INVALID_ARGUMENT")).toBe(2);
    expect(exitCodeFor("NO_DEVICE")).toBe(3);
    expect(exitCodeFor("MISSING_BINARY")).toBe(3);
    expect(exitCodeFor("APP_NOT_FOUND")).toBe(3);
    expect(exitCodeFor("THRESHOLD_FAILED")).toBe(4);
    expect(exitCodeFor("NO_MEASURES")).toBe(1);
    expect(exitCodeFor("INTERNAL")).toBe(1);
  });

  it("never uses 0 or a signal exit code", () => {
    for (const code of ERROR_CODES) {
      expect([1, 2, 3, 4]).toContain(exitCodeFor(code));
    }
  });
});
