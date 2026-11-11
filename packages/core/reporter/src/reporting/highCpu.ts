import { Measure, AveragedTestCaseResult } from "@lantern/types";
import { getStatsByThread, getValuesStats } from "../utils/getValuesStats";
import type { IterationSummary } from "./iterationSummary";
import { getMeasureDurations } from "./timeline";

/** A thread polled above this CPU percentage is considered to be locking its process. */
export const HIGH_CPU_USAGE_THRESHOLD = 90;

/** Time (in ms) each process spent above `cpuUsageThreshold`, in first-seen order. */
export const getHighCpuUsage = (
  measures: Measure[],
  cpuUsageThreshold: number | undefined = HIGH_CPU_USAGE_THRESHOLD
) => {
  const highCpuUsageByProcess: { [processName: string]: number } = {};

  const durations = getMeasureDurations(measures);

  measures.forEach((measure, i) => {
    for (const [processName, cpuUsage] of Object.entries(measure.cpu.perName)) {
      if (cpuUsage > cpuUsageThreshold) {
        highCpuUsageByProcess[processName] =
          (highCpuUsageByProcess[processName] ?? 0) + durations[i];
      }
    }
  });

  return highCpuUsageByProcess;
};

/**
 * Fraction of polls (in [0, 1]) during which at least one thread was above the threshold.
 * Unlike summing per-thread high-CPU time, two threads busy in the same poll count once.
 */
export const getThreadLockedRatio = (
  measures: Measure[],
  cpuUsageThreshold: number | undefined = HIGH_CPU_USAGE_THRESHOLD
) => {
  if (measures.length === 0) return 0;

  const lockedPollCount = measures.filter((measure) =>
    Object.values(measure.cpu.perName).some((cpuUsage) => cpuUsage > cpuUsageThreshold)
  ).length;

  return lockedPollCount / measures.length;
};

export const getAverageTotalHighCPUUsage = (highCpuProcesses: { [processName: string]: number }) =>
  Object.keys(highCpuProcesses).reduce((sum, name) => sum + highCpuProcesses[name], 0);

const getHighCpuStatsByThread = (iterations: IterationSummary[]) => {
  const threads: { [threadName: string]: number[] } = {};

  iterations.forEach((iteration) => {
    Object.entries(iteration.highCpuUsagePerProcess).forEach(([threadName, highCpuUsage]) => {
      if (!threads[threadName]) {
        threads[threadName] = [];
      }
      threads[threadName].push(highCpuUsage);
    });
  });

  return getStatsByThread(threads);
};

export const getHighCpuStats = (
  iterations: IterationSummary[],
  averageResultHighCpuUsage: AveragedTestCaseResult["averageHighCpuUsage"]
) => {
  const averageTotalHighCpu = getAverageTotalHighCPUUsage(averageResultHighCpuUsage);

  return {
    threads: getHighCpuStatsByThread(iterations),
    ...getValuesStats(
      iterations.map((iteration) => iteration.totalHighCpuUsage),
      averageTotalHighCpu
    ),
  };
};

// We compute every time unless there is only one thread and it's called "Total"
export const canComputeHighCpuUsage = (testCaseResult: AveragedTestCaseResult) => {
  if (testCaseResult.average.measures.length === 0) {
    return true;
  }
  const lastMeasure = testCaseResult.average.measures[testCaseResult.average.measures.length - 1];
  const threads = Object.keys(lastMeasure.cpu.perName);
  if (threads.length === 1 && threads[0] === "Total") return false;
  return true;
};
