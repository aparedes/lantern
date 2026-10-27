import fs from "fs";
import path from "path";
import { describe, it, expect } from "bun:test";
import { Measure, POLLING_INTERVAL, TestCaseIterationResult, TestCaseResult } from "@lantern/types";
import { Report } from "../Report";
import { formatResultSummary, summarizeResult } from "../summary";

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
  { status = "SUCCESS", isRetriedIteration }: Partial<TestCaseIterationResult> = {}
): TestCaseIterationResult => ({ measures, time, status, isRetriedIteration });

const result = (
  iterations: TestCaseIterationResult[],
  extra: Partial<TestCaseResult> = {}
): TestCaseResult => ({ name: "Results", status: "SUCCESS", iterations, ...extra });

const EXAMPLE_RESULTS = path.join(
  __dirname,
  "../../../../../commands/report/src/example-reports/results1.json"
);

describe("summarizeResult", () => {
  it("reports the same numbers as the HTML report", () => {
    const example: TestCaseResult = JSON.parse(fs.readFileSync(EXAMPLE_RESULTS, "utf8"));
    const report = new Report(example);
    const metrics = report.getAverageMetrics();

    const summary = summarizeResult(example);

    expect(summary.score).toBe(report.score);
    expect(summary.cpu.avg).toBe(metrics.cpu);
    expect(summary.fps?.avg).toBe(metrics.fps);
    expect(summary.ramMb?.avg).toBe(metrics.ram);
    expect(summary.runtimeMs.avg).toBe(metrics.runtime);
    expect(summary.highCpuSeconds.avg).toBe(metrics.totalHighCpuTime);
    expect(summary.cpu.cv).toBe(report.getStats().cpu.variationCoefficient);
    expect(summary.cpu.n).toBe(report.getIterationCount());
    expect(summary.topThreads[0]).toEqual({
      name: metrics.averageCpuUsagePerProcess[0].processName,
      avgCpu: metrics.averageCpuUsagePerProcess[0].cpuUsage,
      highCpuSeconds: expect.any(Number),
    });
  });

  it("summarizes a run with its spread, device and busiest threads", () => {
    const summary = summarizeResult(
      result(
        [
          iteration(
            [
              measure({ UI: 95, JS: 10 }, { fps: 120, ram: 100 }),
              measure({ UI: 50, JS: 10 }, { fps: 100, ram: 100 }),
            ],
            1000
          ),
          iteration(
            [
              measure({ UI: 20, JS: 20 }, { fps: 120, ram: 300 }),
              measure({ UI: 20, JS: 20 }, { fps: 120, ram: 300 }),
            ],
            2000
          ),
          iteration(
            [
              measure({ UI: 30, JS: 30 }, { fps: 110, ram: 200 }),
              measure({ UI: 30, JS: 30 }, { fps: 110, ram: 200 }),
            ],
            1500
          ),
        ],
        {
          platform: "android",
          device: { id: "R58M12345Z", name: "Pixel 7" },
          specs: { refreshRate: 120 },
        }
      ),
      { topThreads: 1 }
    );

    expect(summary).toEqual({
      schemaVersion: 1,
      name: "Results",
      status: "SUCCESS",
      platform: "android",
      device: { id: "R58M12345Z", name: "Pixel 7" },
      refreshRate: 120,
      iterations: { total: 3, reported: 3, failed: 0, retried: 0 },
      score: expect.any(Number),
      runtimeMs: { avg: 1500, sd: 408, cv: 27.2, min: 1000, max: 2000, n: 3 },
      cpu: { avg: 60.8, sd: 17.4, cv: 28.6, min: 40, max: 82.5, n: 3 },
      fps: { avg: 113.3, sd: 4.7, cv: 4.2, min: 110, max: 120, n: 3 },
      ramMb: { avg: 200, sd: 81.6, cv: 40.8, min: 100, max: 300, n: 3 },
      highCpuSeconds: { avg: 0.2, sd: 0.2, cv: 117.9, min: 0, max: 0.5, n: 3 },
      topThreads: [{ name: "UI", avgCpu: 40.8, highCpuSeconds: 0.2 }],
      caveats: [],
    });
  });

  it("leaves failed iterations out and says so, counting retried ones apart", () => {
    const summary = summarizeResult(
      result(
        [
          iteration([measure({ UI: 400 })], 50000, { status: "FAILURE", isRetriedIteration: true }),
          iteration([measure({ UI: 10 }), measure({ UI: 10 })], 1000),
          iteration([measure({ UI: 10 }), measure({ UI: 10 })], 1000),
          iteration([measure({ UI: 10 }), measure({ UI: 10 })], 1000),
          iteration([measure({ UI: 900 })], 50000, { status: "FAILURE" }),
        ],
        { status: "FAILURE" }
      )
    );

    expect(summary.status).toBe("FAILURE");
    expect(summary.iterations).toEqual({ total: 5, reported: 3, failed: 1, retried: 1 });
    expect(summary.cpu.avg).toBe(10);
    expect(summary.caveats).toContain("1 iteration(s) failed and are left out of the numbers.");
  });

  it("flags a run whose every iteration failed", () => {
    const summary = summarizeResult(
      result([iteration([measure({ UI: 10 })], 1000, { status: "FAILURE" })], {
        status: "FAILURE",
      })
    );

    expect(summary.iterations.reported).toBe(1);
    expect(summary.caveats).toContain("Every iteration failed: the numbers describe failed runs.");
  });

  it("flags iOS-style results without per-thread data", () => {
    const summary = summarizeResult(
      result(
        [1, 2, 3].map(() => iteration([measure({ Total: 30 }, { fps: 60 })], 1000)),
        { platform: "ios", specs: { refreshRate: 60 } }
      )
    );

    expect(summary.topThreads).toEqual([{ name: "Total", avgCpu: 30, highCpuSeconds: 0 }]);
    expect(summary.caveats).toEqual([
      "No per-thread CPU data (iOS): the score has no thread-lock penalty and the only thread is the app's total.",
    ]);
  });

  it("flags a missing refresh rate, few iterations and missing measures", () => {
    expect(
      summarizeResult(result([iteration([measure({ UI: 10 }, { fps: 60 })], 1000)])).caveats
    ).toEqual([
      "No refresh rate recorded: FPS is scored against 60 Hz.",
      "Only 1 iteration(s): the averages are noisy, run more iterations to compare.",
    ]);

    const empty = summarizeResult(result([iteration([], 0)]));
    expect(empty.score).toBe(0);
    expect(empty.fps).toBeUndefined();
    expect(empty.ramMb).toBeUndefined();
    expect(empty.caveats[0]).toBe("The results contain no measures: every number is 0.");
  });

  it("derives the status of older results files, which carry none", () => {
    const legacy = {
      name: "legacy",
      iterations: [iteration([measure({ UI: 10 })], 1000)],
    } as unknown as TestCaseResult;

    expect(summarizeResult(legacy).status).toBe("SUCCESS");
  });
});

describe("formatResultSummary", () => {
  it("renders the key numbers, the busiest threads and the caveats", () => {
    const summary = summarizeResult(
      result(
        [1, 2, 3].map(() =>
          iteration(
            [measure({ UI: 95, JS: 10 }, { fps: 60, ram: 100 }), measure({ UI: 95, JS: 10 })],
            1000
          )
        ),
        { platform: "android", device: { id: "x", name: "Pixel 7" } }
      )
    );

    expect(formatResultSummary(summary)).toMatchInlineSnapshot(`
      "Results: SUCCESS, score 0/100 (android, Pixel 7)
        Iterations   3 reported (3 run, 0 failed, 0 retried)
        Runtime      1000 ms  ±0 (cv 0%, range 1000–1000, n=3)
        CPU          105%  ±0 (cv 0%, range 105–105, n=3)
        FPS          60  ±0 (cv 0%, range 60–60, n=3)
        RAM          100 MB  ±0 (cv 0%, range 100–100, n=3)
        High CPU     1 s  ±0 (cv 0%, range 1–1, n=3)
        Top threads
          95%  UI (1 s above 90%)
          10%  JS
        ⚠ No refresh rate recorded: FPS is scored against 60 Hz."
    `);
  });
});
