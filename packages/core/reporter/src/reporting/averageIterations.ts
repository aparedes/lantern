import {
  AveragedTestCaseResult,
  Measure,
  POLLING_INTERVAL,
  TestCaseIterationResult,
  TestCaseResult,
} from "@lantern/types";
import { getHighCpuUsage, HIGH_CPU_USAGE_THRESHOLD } from "./highCpu";
import { getMeasureOffsets } from "./timeline";

const range = (n: number) =>
  Array(n)
    .fill(null)
    .map((_, i) => i);

/**
 * Mean of the defined samples. Undefined samples are skipped rather than poisoning the whole
 * average; the result is undefined only when no sample is defined.
 */
export const average = (arr: (number | undefined)[]): number | undefined => {
  let sum = 0;
  let count = 0;

  for (const elt of arr) {
    if (elt === undefined) continue;
    sum += elt;
    count++;
  }

  return count === 0 ? undefined : sum / count;
};

const averageMaps = (maps: { [key: string]: number }[]): { [key: string]: number } => {
  const totalByThread = maps.reduce((aggr, map) => {
    Object.keys(map).forEach((key) => {
      aggr[key] = aggr[key] || 0;
      aggr[key] += map[key];
    });
    return aggr;
  }, {});

  return Object.fromEntries(
    Object.entries(totalByThread).map(([key, value]) => [key, value / maps.length])
  );
};

const averageMeasures = (measures: Measure[], time: number): Measure => {
  return {
    cpu: {
      perCore: {},
      perName: averageMaps(measures.map((m) => m.cpu.perName)),
    },
    ram: average(measures.map((m) => m.ram)),
    fps: average(measures.map((m) => m.fps)),
    time,
  };
};

export const averageIterations = (results: TestCaseIterationResult[]): TestCaseIterationResult => {
  const minLength =
    results.length > 0 ? Math.min(...results.map((result) => result.measures.length)) : 0;

  const offsets = results.map((result) => getMeasureOffsets(result.measures));

  return {
    measures: range(minLength).map((i) =>
      averageMeasures(
        results.map((result) => result.measures[i]),
        average(offsets.map((iterationOffsets) => iterationOffsets[i])) ?? i * POLLING_INTERVAL
      )
    ),
    // No iteration at all (e.g. an out of bounds selection): report a 0 runtime rather than NaN
    time: average(results.map((result) => result.time)) ?? 0,
    status: "SUCCESS",
  };
};

export const averageHighCpuUsage = (
  results: TestCaseIterationResult[],
  cpuUsageThreshold = HIGH_CPU_USAGE_THRESHOLD
) => {
  return averageMaps(results.map((result) => getHighCpuUsage(result.measures, cpuUsageThreshold)));
};

export const averageTestCaseResult = (result: TestCaseResult): AveragedTestCaseResult => {
  const averagedIterations = averageIterations(result.iterations);

  return {
    ...result,
    average: averagedIterations,
    averageHighCpuUsage: averageHighCpuUsage(result.iterations),
  };
};
