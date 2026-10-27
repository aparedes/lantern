import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { LogLevel, Logger } from "..";

const consoleError = spyOn(console, "error").mockImplementation(() => {});
const consoleLog = spyOn(console, "log").mockImplementation(() => {});

afterEach(() => {
  consoleError.mockClear();
  consoleLog.mockClear();
});

afterAll(() => {
  Logger.setLogLevel(LogLevel.INFO);
  mock.restore();
});

describe("Logger", () => {
  it("writes every level to stderr, keeping stdout for command results", () => {
    Logger.setLogLevel(LogLevel.TRACE);

    Logger.trace("trace");
    Logger.debug("debug");
    Logger.info("info");
    Logger.success("success");
    Logger.warn("warn");
    Logger.error("error");

    expect(consoleError).toHaveBeenCalledTimes(6);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("drops the messages above the log level", () => {
    Logger.setLogLevel(LogLevel.WARN);

    Logger.info("info");
    Logger.warn("warn");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain("warn");
  });
});
