import os from "os";
import fs from "fs";
import * as perfHooks from "perf_hooks";
import {
  describe,
  it,
  expect,
  jest,
  spyOn,
  mock,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from "bun:test";
import { measurePerformance, PerformanceMeasurer } from "..";
import { PerformancePollingMock } from "../utils/test/PerformancePollingMock";
import { Logger, LogLevel } from "@lantern/logger";
import { profiler } from "@lantern/profiler";

const mockPerformancePolling = new PerformancePollingMock();

spyOn(profiler, "installProfilerOnDevice").mockImplementation(async () => undefined);
spyOn(profiler, "startSession").mockImplementation(mockPerformancePolling.start);

Logger.setLogLevel(LogLevel.SILENT);
setDefaultTimeout(20000);

// Mock test time to be always 1000ms
let isStart = false;
spyOn(perfHooks.performance, "now").mockImplementation(() => {
  isStart = !isStart;
  return isStart ? 0 : 1000;
});

afterEach(() => mockPerformancePolling.reset());
afterAll(() => mock.restore());

const runTest = jest.fn();

describe("measurePerformance", () => {
  it("adds a score if a getScore function is passed", async () => {
    const PATH = `${os.tmpdir()}/results.json`;
    const TITLE = "TITLE";

    const { writeResults } = await measurePerformance(
      "com.example",
      {
        run: runTest,
        getScore: (result) => result.iterations.length,
      },
      {
        iterationCount: 3,
        maxRetries: 3,
        recordOptions: { record: false },
        resultsFileOptions: {
          path: PATH,
          title: TITLE,
        },
      }
    );

    expect(runTest).toHaveBeenCalledTimes(3);

    writeResults();

    expect(JSON.parse(fs.readFileSync(PATH).toString())).toMatchInlineSnapshot(`
      {
        "iterations": [
          {
            "measures": [
              {
                "cpu": {
                  "perCore": {},
                  "perName": {},
                },
                "fps": 60,
                "ram": 0,
                "time": 0,
              },
            ],
            "startTime": 0,
            "status": "SUCCESS",
            "time": 1000,
          },
          {
            "measures": [
              {
                "cpu": {
                  "perCore": {},
                  "perName": {},
                },
                "fps": 60,
                "ram": 0,
                "time": 0,
              },
            ],
            "startTime": 0,
            "status": "SUCCESS",
            "time": 1000,
          },
          {
            "measures": [
              {
                "cpu": {
                  "perCore": {},
                  "perName": {},
                },
                "fps": 60,
                "ram": 0,
                "time": 0,
              },
            ],
            "startTime": 0,
            "status": "SUCCESS",
            "time": 1000,
          },
        ],
        "name": "TITLE",
        "score": 3,
        "status": "SUCCESS",
      }
    `);
  });

  it("runs the test right away, the profiler starting to measure once the test launched the app", async () => {
    // On Android the profiler only samples once the app runs, and `lantern test` force-stops the
    // app before each iteration: the test command is what launches it
    mockPerformancePolling.startsMeasuring = false;
    runTest.mockImplementationOnce(async () => {
      expect(mockPerformancePolling.isStarted()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      mockPerformancePolling.reportStarted();
    });

    const { measures } = await measurePerformance(
      "com.example",
      { run: runTest },
      { iterationCount: 1 }
    );

    expect(runTest).toHaveBeenCalled();
    expect(measures).toHaveLength(1);
    expect(measures[0].status).toBe("SUCCESS");
    expect(measures[0].measures).toHaveLength(1);
  });

  it("waits for a certain duration", async () => {
    const DURATION = 1500;
    const interval = setInterval(() => mockPerformancePolling.emit({}), 10);
    const { measures } = await measurePerformance(
      "com.example",
      { run: runTest, duration: DURATION },
      { iterationCount: 1 }
    );

    // DURATION is 1500
    // So wait to have points 0 / 500 / 1000 and 1500 so 4 measures
    expect(measures[0].measures.length).toEqual(4);

    clearInterval(interval);
  });

  it("retries tests if they fail", async () => {
    const mockFailingTest = (failureCount: number) => {
      for (let i = 0; i < failureCount; i++) {
        runTest.mockImplementationOnce(async () => {
          throw new Error("Failure");
        });
      }
    };

    const MAX_RETRIES = 2;
    mockFailingTest(2);
    await measurePerformance(
      "com.example",
      { run: runTest },
      {
        iterationCount: 3,
        maxRetries: MAX_RETRIES,
      }
    );

    mockFailingTest(3);
    await expect(
      measurePerformance(
        "com.example",
        { run: runTest },
        {
          iterationCount: 3,
          maxRetries: MAX_RETRIES,
        }
      )
    ).rejects.toThrowError("Max number of retries reached.");
  });

  it("throws an error if no measures are returned", async () => {
    runTest.mockImplementationOnce(async () => Promise.resolve());
    await expect(
      measurePerformance(
        "com.example",
        { run: runTest },
        {
          iterationCount: 0,
        }
      )
    ).rejects.toThrowError("No measure returned");
  });

  it("releases the profiler once the iterations are over, and when they fail", async () => {
    const dispose = spyOn(profiler, "dispose").mockImplementation(() => undefined);
    try {
      runTest.mockImplementationOnce(async () => {
        mockPerformancePolling.emit({});
      });
      await measurePerformance("com.example", { run: runTest }, { iterationCount: 1 });
      // The iOS profiler holds a `serve` child open, which would keep an embedding script alive
      expect(dispose).toHaveBeenCalledTimes(1);

      runTest.mockImplementationOnce(async () => Promise.resolve());
      await expect(
        measurePerformance("com.example", { run: runTest }, { iterationCount: 0 })
      ).rejects.toThrow("No measure returned");
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      dispose.mockRestore();
    }
  });
});

describe("PerformanceMeasurer", () => {
  const neverEndingTask = () => new Promise<void>(() => {});

  it("rejects waitUntilMeasuring() when the profiler never starts measuring", async () => {
    mockPerformancePolling.startsMeasuring = false;
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
      startTimeout: 100,
    });

    await measurer.start();

    await expect(measurer.waitUntilMeasuring()).rejects.toThrowError(
      'The profiler did not start measuring within 100ms, is "com.example" running on the device?'
    );
  });

  it("resolves a pending waitUntilMeasuring() when force stopped", async () => {
    mockPerformancePolling.startsMeasuring = false;
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
      startTimeout: 100,
    });

    await measurer.start();
    const measuring = measurer.waitUntilMeasuring();
    measurer.forceStop();

    await expect(measuring).resolves.toBeUndefined();
  });

  it("fails runWhileMeasuring() while the task still runs when the profiler never starts", async () => {
    mockPerformancePolling.startsMeasuring = false;
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
      startTimeout: 100,
    });
    await measurer.start();

    const task = jest.fn(neverEndingTask);
    await expect(measurer.runWhileMeasuring(task)).rejects.toThrowError(
      "The profiler did not start measuring within 100ms"
    );
    expect(task).toHaveBeenCalled();
  });

  it("fails runWhileMeasuring() as soon as the profiler exits", async () => {
    mockPerformancePolling.startsMeasuring = false;
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
    });
    await measurer.start();

    const running = measurer.runWhileMeasuring(neverEndingTask);
    mockPerformancePolling.end("lantern-android-profiler exited unexpectedly (code 1)");

    await expect(running).rejects.toThrowError(
      "The profiler stopped before it started measuring: lantern-android-profiler exited unexpectedly (code 1)"
    );
  });

  it("runWhileMeasuring() returns what the task returns once the profiler measures", async () => {
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
    });
    await measurer.start();

    await expect(measurer.runWhileMeasuring(() => "done")).resolves.toBe("done");
    await expect(measurer.waitUntilMeasuring()).resolves.toBeUndefined();
  });

  it("rejects stop() when no measures were received", async () => {
    mockPerformancePolling.emitsMeasureOnStart = false;
    const measurer = new PerformanceMeasurer("com.example", {
      recordOptions: { record: false },
    });

    await measurer.start();

    await expect(measurer.stop()).rejects.toThrowError(
      'No measures were received from the profiler for "com.example"'
    );
  });
});
