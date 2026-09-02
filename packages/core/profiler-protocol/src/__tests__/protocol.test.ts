import { describe, expect, it } from "bun:test";
import {
  ERROR_MARKER,
  WARN_MARKER,
  isAndroidRawMeasureLine,
  lastErrorMessage,
  parseMarkerLine,
  parseProfilerLine,
} from "..";

describe("parseProfilerLine", () => {
  it("parses NDJSON lines with a string type", () => {
    expect(parseProfilerLine('{"type":"status","event":"started","pid":12}')).toEqual({
      type: "status",
      event: "started",
      pid: 12,
    });
  });

  it("rejects anything that is not one of the binaries' line objects", () => {
    expect(parseProfilerLine("not json")).toBeUndefined();
    expect(parseProfilerLine("")).toBeUndefined();
    expect(parseProfilerLine("null")).toBeUndefined();
    expect(parseProfilerLine("42")).toBeUndefined();
    expect(parseProfilerLine('{"event":"started"}')).toBeUndefined();
    expect(parseProfilerLine('{"type":7}')).toBeUndefined();
  });
});

describe("isAndroidRawMeasureLine", () => {
  const measure = {
    type: "measure",
    pid: "1234",
    cpu: "1234 (com.example) S 1 2\n1235 (Signal Catcher) S 1 2",
    ram: "4430198 96195 58113 3 0 398896 0",
    atrace: "",
    timestamp: 1700000000000,
    timings: { totalMs: 12, cpuMs: 5, ramMs: 1, atraceMs: 6 },
  };

  it("accepts what the Android binary emits", () => {
    expect(isAndroidRawMeasureLine(measure)).toBe(true);
    expect(isAndroidRawMeasureLine(parseProfilerLine(JSON.stringify(measure)))).toBe(true);
  });

  it("rejects other line types, missing or mistyped fields", () => {
    expect(isAndroidRawMeasureLine({ type: "status", event: "started" })).toBe(false);
    expect(isAndroidRawMeasureLine({ ...measure, pid: 1234 })).toBe(false);
    expect(isAndroidRawMeasureLine({ ...measure, timestamp: "1700000000000" })).toBe(false);
    expect(isAndroidRawMeasureLine({ ...measure, atrace: undefined })).toBe(false);
    expect(isAndroidRawMeasureLine({ ...measure, timings: { totalMs: 1 } })).toBe(false);
    expect(isAndroidRawMeasureLine(null)).toBe(false);
    expect(isAndroidRawMeasureLine("measure")).toBe(false);
    // The iOS measure line has a different shape
    expect(
      isAndroidRawMeasureLine({
        type: "measure",
        time: 1,
        cpu: { perName: {}, perCore: {} },
        ram: 1,
        threadCount: 1,
        pid: 1,
      })
    ).toBe(false);
  });
});

describe("parseMarkerLine", () => {
  it("splits error and warn markers into level, code and message", () => {
    expect(parseMarkerLine(`${ERROR_MARKER}NO_DEVICE: no device found`)).toEqual({
      level: "error",
      code: "NO_DEVICE",
      message: "no device found",
    });
    expect(parseMarkerLine(`${WARN_MARKER}CANNOT_OPEN_FILE: /proc/1/task/2/stat`)).toEqual({
      level: "warn",
      code: "CANNOT_OPEN_FILE",
      message: "/proc/1/task/2/stat",
    });
  });

  it("keeps an empty message and a message containing colons", () => {
    expect(parseMarkerLine(`${ERROR_MARKER}USAGE:`)).toEqual({
      level: "error",
      code: "USAGE",
      message: "",
    });
    expect(parseMarkerLine(`${ERROR_MARKER}SERVICE_FAILED: instruments: Closed`)?.message).toBe(
      "instruments: Closed"
    );
  });

  it("returns undefined for anything else", () => {
    expect(parseMarkerLine("idevice noise")).toBeUndefined();
    expect(parseMarkerLine("")).toBeUndefined();
    expect(parseMarkerLine("LANTERN_PROFILER_INFO_X: nope")).toBeUndefined();
    // Markers are matched at the start of a line only
    expect(parseMarkerLine(`prefix ${ERROR_MARKER}NO_DEVICE: x`)).toBeUndefined();
  });
});

describe("lastErrorMessage", () => {
  it("returns the message of the only error marker", () => {
    expect(lastErrorMessage(`${ERROR_MARKER}NO_DEVICE: no device found\n`)).toBe("no device found");
  });

  it("picks the last error marker so context lines do not mask the failure", () => {
    const stderr = [
      `${ERROR_MARKER}SERVICE_FAILED: application listing: Closed`,
      "some idevice debug output",
      `${ERROR_MARKER}APP_NOT_FOUND: com.example is not running`,
    ].join("\n");

    expect(lastErrorMessage(stderr)).toBe("com.example is not running");
  });

  it("ignores warn markers", () => {
    const stderr = [
      `${WARN_MARKER}TUNNEL_FAILED: CoreDevice tunnel unavailable, trying lockdown fallback`,
      `${ERROR_MARKER}SERVICE_FAILED: instruments: Closed`,
    ].join("\n");

    expect(lastErrorMessage(stderr)).toBe("instruments: Closed");
    expect(
      lastErrorMessage(`${WARN_MARKER}TUNNEL_FAILED: CoreDevice tunnel unavailable\n`)
    ).toBeUndefined();
  });

  it("returns undefined when there is no marker", () => {
    expect(lastErrorMessage("")).toBeUndefined();
    expect(lastErrorMessage("Command failed with exit code 1")).toBeUndefined();
  });
});
