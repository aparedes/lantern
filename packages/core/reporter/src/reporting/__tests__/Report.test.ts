import { describe, it, expect } from "bun:test";
import { Measure, POLLING_INTERVAL, TestCaseIterationResult, TestCaseResult } from "@lantern/types";
import { Report } from "../Report";

const measure = (
  perName: { [processName: string]: number },
  { fps, ram }: { fps?: number; ram?: number } = {}
): Measure => ({
  cpu: { perCore: {}, perName },
  fps,
  ram,
  time: POLLING_INTERVAL,
});

const iteration = (
  measures: Measure[],
  time: number,
  status: TestCaseIterationResult["status"] = "SUCCESS"
): TestCaseIterationResult => ({ measures, time, status });

const SUCCESSFUL_ITERATION_1 = iteration(
  [
    measure({ UI: 50, JS: 10 }, { fps: 60, ram: 100 }),
    measure({ UI: 100, JS: 10 }, { fps: 30, ram: 100 }),
  ],
  1000
);
const SUCCESSFUL_ITERATION_2 = iteration(
  [
    measure({ UI: 20, JS: 20 }, { fps: 60, ram: 300 }),
    measure({ UI: 20, JS: 20 }, { fps: 60, ram: 300 }),
  ],
  2000
);
const FAILED_ITERATION = iteration(
  [measure({ UI: 400, JS: 400 }, { fps: 0, ram: 9000 })],
  50000,
  "FAILURE"
);

const buildResult = (
  iterations: TestCaseIterationResult[],
  status: TestCaseResult["status"] = "SUCCESS"
): TestCaseResult => ({ name: "test", status, iterations });

describe("Report", () => {
  it("only averages successful iterations, whatever the overall status", () => {
    const iterations = [SUCCESSFUL_ITERATION_1, FAILED_ITERATION, SUCCESSFUL_ITERATION_2];

    for (const status of ["SUCCESS", "FAILURE"] as const) {
      const report = new Report(buildResult(iterations, status));

      expect(report.status).toBe(status);
      expect(report.getIterationCount()).toBe(2);
      expect(report.getAveragedResult().iterations).toEqual([
        SUCCESSFUL_ITERATION_1,
        SUCCESSFUL_ITERATION_2,
      ]);
      expect(report.getAverageMetrics()).toMatchObject({
        runtime: 1500,
        cpu: 62.5,
        fps: 52.5,
        ram: 200,
      });
    }
  });

  it("keeps iterations without a status (legacy result files)", () => {
    const legacyIteration = { measures: SUCCESSFUL_ITERATION_1.measures, time: 1000 };
    const report = new Report({
      name: "legacy",
      iterations: [legacyIteration],
    } as unknown as TestCaseResult);

    expect(report.getIterationCount()).toBe(1);
    expect(report.hasMeasures()).toBe(true);
    expect(report.getAverageMetrics().cpu).toBe(85);
  });

  it("falls back to the failed iterations when every iteration failed", () => {
    const otherFailedIteration = iteration(
      [measure({ UI: 200, JS: 200 }, { fps: 10, ram: 7000 })],
      30000,
      "FAILURE"
    );
    const report = new Report(buildResult([FAILED_ITERATION, otherFailedIteration], "FAILURE"));

    // The failed run (retries exhausted) stays browsable next to the healthy reports
    expect(report.status).toBe("FAILURE");
    expect(report.getIterationCount()).toBe(2);
    expect(report.hasMeasures()).toBe(true);
    expect(report.getAveragedResult().iterations).toEqual([FAILED_ITERATION, otherFailedIteration]);
    expect(report.getAverageMetrics()).toMatchObject({
      runtime: 40000,
      cpu: 600,
      fps: 5,
      ram: 8000,
    });
    expect(report.selectIteration(1).getAverageMetrics().runtime).toBe(30000);
  });

  it("reports no measures and a 0 runtime without any iteration", () => {
    for (const report of [
      new Report(buildResult([], "FAILURE")),
      new Report(buildResult([SUCCESSFUL_ITERATION_1])).selectIteration(1),
    ]) {
      expect(report.getIterationCount()).toBe(0);
      expect(report.hasMeasures()).toBe(false);
      expect(report.score).toBe(0);
      expect(report.getAverageMetrics()).toEqual({
        runtime: 0,
        fps: undefined,
        fpsMin: undefined,
        cpu: 0,
        totalHighCpuTime: 0,
        ram: undefined,
        ramPeak: undefined,
        averageCpuUsagePerProcess: [],
      });
      expect(report.getStats().runtime).toEqual({
        minMaxRange: [0, 0],
        deviationRange: [0, 0],
        variationCoefficient: 0,
      });
    }
  });

  it("keeps a 0 FPS / 0 RAM average instead of treating it as missing", () => {
    const report = new Report(
      buildResult([iteration([measure({ UI: 10 }, { fps: 0, ram: 0 })], 1000)])
    );

    expect(report.getAverageMetrics()).toMatchObject({ fps: 0, ram: 0 });
    expect(report.getStats().fps).toEqual({
      minMaxRange: [0, 0],
      deviationRange: [0, 0],
      variationCoefficient: 0,
    });
  });

  it("selects successful iterations by index and tolerates out of bounds indices", () => {
    const report = new Report(
      buildResult([FAILED_ITERATION, SUCCESSFUL_ITERATION_1, SUCCESSFUL_ITERATION_2])
    );

    expect(report.selectIteration(1).getAverageMetrics().runtime).toBe(2000);
    expect(report.selectIteration(0).getAverageMetrics().runtime).toBe(1000);
    expect(report.selectIteration(2).getIterationCount()).toBe(0);
    expect(report.selectIteration(-1).getIterationCount()).toBe(0);
    expect(report.selectIteration(2).hasMeasures()).toBe(false);
  });

  it("computes stats from every successful iteration, even with uneven lengths", () => {
    const longIteration = iteration(
      [
        measure({ UI: 50 }, { fps: 60, ram: 100 }),
        measure({ UI: 50 }, { fps: 60, ram: 100 }),
        measure({ UI: 50 }, { fps: 60, ram: 100 }),
        measure({ UI: 350 }, { fps: 60, ram: 100 }),
      ],
      1000
    );
    const shortIteration = iteration([measure({ UI: 100 }, { fps: 30, ram: 200 })], 3000);
    const report = new Report(buildResult([longIteration, shortIteration]));
    const stats = report.getStats();

    // Averaged measures are truncated to the shortest iteration: (50 + 100) / 2
    expect(report.getAverageMetrics().cpu).toBe(75);
    // ...but the stats use the full per-iteration averages: 125 and 100
    expect(stats.cpu.minMaxRange).toEqual([100, 125]);
    expect(stats.cpu.deviationRange).toEqual([100, 125]);
    expect(stats.runtime).toEqual({
      minMaxRange: [1000, 3000],
      deviationRange: [1000, 3000],
      variationCoefficient: 50,
    });
    expect(stats.ram?.minMaxRange).toEqual([100, 200]);
    expect(stats.fps?.minMaxRange).toEqual([30, 60]);
    expect(stats.threads.UI.minMaxRange).toEqual([100, 125]);
    expect(stats.highCpu.threads.UI).toEqual({
      minMaxRange: [500, 500],
      deviationRange: [500, 500],
      variationCoefficient: 0,
    });
  });

  it("caches stats and score across calls", () => {
    const report = new Report(buildResult([SUCCESSFUL_ITERATION_1, SUCCESSFUL_ITERATION_2]));

    expect(report.getStats()).toBe(report.getStats());
    expect(report.score).toBe(report.score);
  });

  it("exposes the device recorded in the result file", () => {
    const specs = { refreshRate: 120, platform: "android" as const, deviceName: "Pixel 7" };

    expect(new Report({ ...buildResult([SUCCESSFUL_ITERATION_1]), specs }).getSpecs()).toEqual(
      specs
    );
    expect(new Report(buildResult([SUCCESSFUL_ITERATION_1])).getSpecs()).toBeUndefined();
  });

  it("averages the lowest FPS and the peak RAM of each iteration", () => {
    const report = new Report(buildResult([SUCCESSFUL_ITERATION_1, SUCCESSFUL_ITERATION_2]));

    // Lowest FPS: 30 and 60. Peak RAM: 100 and 300
    expect(report.getAverageMetrics()).toMatchObject({ fpsMin: 45, ramPeak: 200 });
    expect(report.getStats().fpsMin?.minMaxRange).toEqual([30, 60]);
    expect(report.getStats().ramPeak?.minMaxRange).toEqual([100, 300]);
  });

  it("has no lowest FPS nor peak RAM when no sample carries them", () => {
    const report = new Report(buildResult([iteration([measure({ UI: 10 })], 1000)]));

    expect(report.getAverageMetrics().fpsMin).toBeUndefined();
    expect(report.getAverageMetrics().ramPeak).toBeUndefined();
    expect(report.getStats().fpsMin).toBeUndefined();
    expect(report.getStats().ramPeak).toBeUndefined();
  });

  it("measures high CPU time with the real spacing of the samples", () => {
    const spaced = (time: number, perName: { [name: string]: number }): Measure => ({
      ...measure(perName),
      time,
    });
    const report = new Report(
      buildResult([
        iteration(
          [
            spaced(0, { UI: 100 }),
            spaced(510, { UI: 100 }),
            spaced(1020, { UI: 10 }),
            spaced(1530, { UI: 100 }),
          ],
          1530
        ),
      ])
    );

    expect(report.getStats().highCpu.threads.UI.minMaxRange).toEqual([1530, 1530]);
    expect(report.getAverageMetrics().totalHighCpuTime).toBe(1.5);
  });

  it("uses the score stored on the result when present", () => {
    const report = new Report({ ...buildResult([SUCCESSFUL_ITERATION_1]), score: 12 });
    expect(report.score).toBe(12);
  });
});
