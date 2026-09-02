import "../utils/test/mockChildProcess";
import { describe, it, expect, spyOn } from "bun:test";
import { LogLevel, Logger } from "@lantern/logger";
import { waitFor } from "@lantern/profiler";
import { PerformanceMeasurer } from "../PerformanceMeasurer";
import {
  emitMeasure,
  emitPidChanged,
  emitStarted,
  flushLines,
  perfProfilerMock,
} from "../utils/test/mockEmitMeasures";

Logger.setLogLevel(LogLevel.SILENT);

const loggerDebug = spyOn(Logger, "debug");
const loggerError = spyOn(Logger, "error");

describe("PerformanceMeasurer", () => {
  it("handles profiler status events and markers correctly", async () => {
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: {
        record: false,
      },
    });
    await measurer.start();
    await waitFor(() => measurer.polling);
    emitStarted();
    // The profiler reports it has started measuring once it took its first (baseline) sample
    emitMeasure(0);
    await measurer.waitUntilMeasuring();
    emitMeasure(1);
    perfProfilerMock.stderr.write(
      "LANTERN_PROFILER_WARN_CANNOT_OPEN_FILE: /proc/1234/tasks/578/stat\n"
    );
    emitMeasure(2);
    await flushLines();

    // A thread dying mid-measure is expected: debug, not error
    expect(loggerDebug).toHaveBeenCalledWith(
      "LANTERN_PROFILER_WARN_CANNOT_OPEN_FILE: /proc/1234/tasks/578/stat"
    );
    expect(loggerError).not.toHaveBeenCalled();

    expect(measurer.measures).toHaveLength(2);
    expect(measurer.measures).toMatchSnapshot();

    // Reset measures when pid changes
    emitPidChanged();
    emitStarted();
    emitMeasure(0);
    await flushLines();
    expect(measurer.measures).toHaveLength(0);

    emitMeasure(1);
    emitMeasure(2);
    await flushLines();

    expect(measurer.measures).toHaveLength(2);
  });
});
