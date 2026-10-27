import { Platform, ResultDevice, TestCaseResult, TestCaseResultStatus } from "@lantern/types";
import { getMinMax } from "../utils/getMinMax";
import { getStandardDeviation } from "../utils/getStandardDeviation";
import { roundToDecimal } from "../utils/round";
import { variationCoefficient } from "../utils/variationCoefficient";
import { canComputeHighCpuUsage } from "./highCpu";
import { Report } from "./Report";

/** Spread of one metric across the reported iterations (one value per iteration). */
export interface MetricStats {
  /** The average shown in the HTML report. */
  avg: number;
  /** Population standard deviation across iterations. */
  sd: number;
  /** Coefficient of variation, in % of `avg` (as in the HTML report). */
  cv: number;
  min: number;
  max: number;
  /** Number of iterations the stats are computed over. */
  n: number;
}

export interface ThreadSummary {
  name: string;
  /** Average CPU usage of the thread, in % of one core. */
  avgCpu: number;
  /** Average time per iteration the thread spent above the high CPU threshold (90 %). */
  highCpuSeconds: number;
}

/**
 * A compact, stable digest of a results file, for scripts and agents: the numbers the HTML
 * report shows, without the raw measures. Bump `schemaVersion` on any breaking change.
 */
export interface ResultSummary {
  schemaVersion: 1;
  name: string;
  status: TestCaseResultStatus;
  platform?: Platform;
  device?: ResultDevice;
  /** Refresh rate FPS is scored against; missing when the results do not record it (60 Hz is assumed). */
  refreshRate?: number;
  iterations: {
    /** Every iteration in the file, retried ones included. */
    total: number;
    /** The iterations the numbers below are computed over. */
    reported: number;
    /** Failed iterations that were not retried. */
    failed: number;
    /** Failed iterations that were run again. */
    retried: number;
  };
  /** Performance score, out of 100. */
  score: number;
  runtimeMs: MetricStats;
  /** Total CPU usage of the app, in % of one core (can exceed 100 on several cores). */
  cpu: MetricStats;
  fps?: MetricStats;
  ramMb?: MetricStats;
  /** Average time per iteration threads spent above the high CPU threshold, summed over threads. */
  highCpuSeconds: MetricStats;
  /** The busiest threads, by average CPU usage. */
  topThreads: ThreadSummary[];
  /** Things to keep in mind when reading the numbers. */
  caveats: string[];
}

export interface SummarizeOptions {
  /** How many threads `topThreads` lists. Defaults to 10. */
  topThreads?: number;
}

const toStats = (average: number, values: number[], decimals = 1): MetricStats => {
  const { deviation } = getStandardDeviation({ values });
  const [min, max] = getMinMax(values);

  return {
    avg: average,
    sd: roundToDecimal(deviation, decimals),
    cv: variationCoefficient(average, deviation),
    min,
    max,
    n: values.length,
  };
};

const defined = (values: (number | undefined)[]) =>
  values.filter((value): value is number => value !== undefined);

/** `result` → its `ResultSummary`, computed with the same `Report` as the HTML report. */
export const summarizeResult = (
  result: TestCaseResult,
  { topThreads = 10 }: SummarizeOptions = {}
): ResultSummary => {
  const report = new Report(result);
  const metrics = report.getAverageMetrics();
  const iterations = report.getIterationSummaries();
  const averagedResult = report.getAveragedResult();

  const retried = result.iterations.filter((iteration) => iteration.isRetriedIteration).length;
  const failed = result.iterations.filter(
    (iteration) => iteration.status === "FAILURE" && !iteration.isRetriedIteration
  ).length;

  const fpsValues = defined(iterations.map((iteration) => iteration.fps));
  const ramValues = defined(iterations.map((iteration) => iteration.ram));

  const caveats: string[] = [];
  if (!report.hasMeasures()) {
    caveats.push("The results contain no measures: every number is 0.");
  }
  if (failed > 0 && failed === result.iterations.length - retried) {
    caveats.push("Every iteration failed: the numbers describe failed runs.");
  } else if (failed > 0) {
    caveats.push(`${failed} iteration(s) failed and are left out of the numbers.`);
  }
  if (report.hasMeasures() && !canComputeHighCpuUsage(averagedResult)) {
    caveats.push(
      "No per-thread CPU data (iOS): the score has no thread-lock penalty and the only thread is the app's total."
    );
  }
  if (result.specs?.refreshRate === undefined && metrics.fps !== undefined) {
    caveats.push("No refresh rate recorded: FPS is scored against 60 Hz.");
  }
  if (iterations.length > 0 && iterations.length < 3) {
    caveats.push(
      `Only ${iterations.length} iteration(s): the averages are noisy, run more iterations to compare.`
    );
  }

  return {
    schemaVersion: 1,
    name: result.name,
    // Older results files carry no status: derived like `lantern test` does
    status: result.status ?? (failed > 0 ? "FAILURE" : "SUCCESS"),
    ...(result.platform !== undefined && { platform: result.platform }),
    ...(result.device !== undefined && { device: result.device }),
    ...(result.specs?.refreshRate !== undefined && { refreshRate: result.specs.refreshRate }),
    iterations: { total: result.iterations.length, reported: iterations.length, failed, retried },
    score: report.score,
    runtimeMs: toStats(
      metrics.runtime,
      iterations.map((iteration) => iteration.time),
      0
    ),
    cpu: toStats(
      metrics.cpu,
      iterations.map((iteration) => iteration.cpuUsage)
    ),
    ...(metrics.fps !== undefined && { fps: toStats(metrics.fps, fpsValues) }),
    ...(metrics.ram !== undefined && { ramMb: toStats(metrics.ram, ramValues) }),
    highCpuSeconds: toStats(
      metrics.totalHighCpuTime,
      iterations.map((iteration) => iteration.totalHighCpuUsage / 1000)
    ),
    topThreads: metrics.averageCpuUsagePerProcess
      .slice(0, topThreads)
      .map(({ processName, cpuUsage }) => ({
        name: processName,
        avgCpu: cpuUsage,
        highCpuSeconds: roundToDecimal(
          (averagedResult.averageHighCpuUsage[processName] ?? 0) / 1000,
          1
        ),
      })),
    caveats,
  };
};

const formatStats = (stats: MetricStats, unit: string) =>
  `${stats.avg}${unit}  ±${stats.sd} (cv ${stats.cv}%, range ${stats.min}–${stats.max}, n=${stats.n})`;

/** A short human-readable rendering of a summary, for the terminal. */
export const formatResultSummary = (summary: ResultSummary): string => {
  const device = [
    summary.platform,
    summary.device?.name,
    summary.refreshRate !== undefined ? `${summary.refreshRate} Hz` : undefined,
  ].filter(Boolean);
  const { iterations } = summary;

  const lines = [
    `${summary.name}: ${summary.status}, score ${summary.score}/100${
      device.length > 0 ? ` (${device.join(", ")})` : ""
    }`,
    `  Iterations   ${iterations.reported} reported (${iterations.total} run, ${iterations.failed} failed, ${iterations.retried} retried)`,
    `  Runtime      ${formatStats(summary.runtimeMs, " ms")}`,
    `  CPU          ${formatStats(summary.cpu, "%")}`,
    ...(summary.fps ? [`  FPS          ${formatStats(summary.fps, "")}`] : []),
    ...(summary.ramMb ? [`  RAM          ${formatStats(summary.ramMb, " MB")}`] : []),
    `  High CPU     ${formatStats(summary.highCpuSeconds, " s")}`,
  ];

  if (summary.topThreads.length > 0) {
    lines.push("  Top threads");
    for (const thread of summary.topThreads) {
      lines.push(
        `    ${thread.avgCpu}%  ${thread.name}${
          thread.highCpuSeconds > 0 ? ` (${thread.highCpuSeconds} s above 90%)` : ""
        }`
      );
    }
  }

  for (const caveat of summary.caveats) {
    lines.push(`  ⚠ ${caveat}`);
  }

  return lines.join("\n");
};
