import { measurePerformance } from "..";
import fs from "fs";
import {
  describe,
  it,
  expect,
  jest,
  spyOn,
  mock,
  beforeAll,
  afterAll,
  afterEach,
  setSystemTime,
} from "bun:test";
import * as PerformanceTester from "../PerformanceTester";
import * as writeReport from "../writeReport";
import { Logger, LogLevel } from "@lantern/logger";
import { profiler } from "@lantern/profiler";

spyOn(profiler, "installProfilerOnDevice").mockImplementation(async () => undefined);

Logger.setLogLevel(LogLevel.SILENT);

const mockDate = () => {
  setSystemTime(new Date(1686650793058));
};

const mockPerformanceTester = () => {
  spyOn(PerformanceTester.PerformanceTester.prototype, "iterate").mockResolvedValue(undefined);
};

afterAll(() => {
  setSystemTime();
  mock.restore();
});

const runTest = jest.fn();

const runMeasures = async (resultsFileOptions?: { path?: string; title?: string }) => {
  const { writeResults } = await measurePerformance(
    "com.example",
    {
      run: runTest,
    },
    {
      resultsFileOptions,
    }
  );
  writeResults();
};

describe("writeResults", () => {
  beforeAll(() => {
    mockDate();
    mockPerformanceTester();
  });

  const writeReportSpy = spyOn(writeReport, "writeReport");

  afterEach(() => {
    writeReportSpy.mockClear();
  });

  it.each([
    [
      {
        options: undefined,
        expected: {
          filePath: `${process.cwd()}/results_1686650793058.json`,
          overrideScore: undefined,
          title: "Results",
        },
      },
    ],
    [
      {
        options: {
          title: "Awesome title",
        },
        expected: {
          filePath: `${process.cwd()}/awesome_title_1686650793058.json`,
          overrideScore: undefined,
          title: "Awesome title",
        },
      },
    ],
    [
      {
        options: {
          path: "/tmp/lantern_test.json",
          title: "Awesome title",
        },
        expected: {
          filePath: `/tmp/lantern_test.json`,
          overrideScore: undefined,
          title: "Awesome title",
        },
      },
    ],
    [
      {
        options: {
          path: "/tmp/lantern_test.json",
        },
        expected: {
          filePath: `/tmp/lantern_test.json`,
          overrideScore: undefined,
          title: "Results",
        },
      },
    ],
  ])("writes results to a file", async ({ options, expected }) => {
    await runMeasures(options);
    expect(writeReportSpy).toHaveBeenCalledWith([], expected);
    fs.rmSync(expected.filePath);
  });
});
