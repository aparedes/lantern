import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { TestCaseIterationResult } from "@lantern/types";
import { getTestCaseStatus, writeReport } from "../writeReport";

Logger.setLogLevel(LogLevel.SILENT);

const iteration = (
  status: TestCaseIterationResult["status"],
  isRetriedIteration?: boolean
): TestCaseIterationResult => ({ time: 0, measures: [], status, isRetriedIteration });

describe("getTestCaseStatus", () => {
  it("fails when there are no iterations", () => {
    expect(getTestCaseStatus([])).toBe("FAILURE");
  });

  it("succeeds when all iterations succeeded", () => {
    expect(getTestCaseStatus([iteration("SUCCESS"), iteration("SUCCESS")])).toBe("SUCCESS");
  });

  it("fails when any iteration failed, not only the last one", () => {
    expect(getTestCaseStatus([iteration("FAILURE"), iteration("SUCCESS")])).toBe("FAILURE");
    expect(getTestCaseStatus([iteration("SUCCESS"), iteration("FAILURE")])).toBe("FAILURE");
  });

  it("ignores failed iterations that were retried", () => {
    expect(getTestCaseStatus([iteration("FAILURE", true), iteration("SUCCESS")])).toBe("SUCCESS");
  });
});

describe("writeReport", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-write-report-"));
  const filePath = path.join(directory, "results.json");
  const read = () => JSON.parse(fs.readFileSync(filePath).toString());

  afterEach(() => fs.rmSync(filePath, { force: true }));

  it("writes the device specs when given", () => {
    const specs = { refreshRate: 120, platform: "android" as const, deviceName: "Pixel 7" };
    writeReport([iteration("SUCCESS")], { filePath, title: "title", specs });

    expect(read().specs).toEqual(specs);
  });

  it("leaves specs out of the file when not given", () => {
    writeReport([iteration("SUCCESS")], { filePath, title: "title" });

    expect(read()).not.toHaveProperty("specs");
  });

  it("hands the specs to a custom score", () => {
    let seenRefreshRate: number | undefined;
    writeReport([iteration("SUCCESS")], {
      filePath,
      title: "title",
      specs: { refreshRate: 90 },
      overrideScore: (result) => {
        seenRefreshRate = result.specs?.refreshRate;
        return 50;
      },
    });

    expect(seenRefreshRate).toBe(90);
    expect(read().score).toBe(50);
  });
});
