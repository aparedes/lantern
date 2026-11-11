import { TestCaseIterationResult } from "@lantern/types";
import { averageCpuUsagePerProcess, ProcessCpuUsage, sortByCpuUsage, sumCpuUsage } from "./cpu";
import { getAverageFPSUsage, getLowestFPS } from "./fps";
import { getAverageTotalHighCPUUsage, getHighCpuUsage } from "./highCpu";
import { getAverageRAMUsage, getPeakRAMUsage } from "./ram";

/**
 * Per-iteration aggregates every stat is derived from. Computed once per iteration so that
 * `Report.getStats()` never walks the raw measures again.
 */
export interface IterationSummary {
  /** Average CPU usage per process, unrounded, sorted by descending usage. */
  cpuUsagePerProcess: ProcessCpuUsage[];
  /** Sum of `cpuUsagePerProcess`. */
  cpuUsage: number;
  /** Time (ms) each process spent above the high CPU threshold. */
  highCpuUsagePerProcess: { [processName: string]: number };
  /** Sum of `highCpuUsagePerProcess`. */
  totalHighCpuUsage: number;
  fps: number | undefined;
  /** Lowest FPS sample of the iteration. */
  fpsMin: number | undefined;
  ram: number | undefined;
  /** Highest RAM sample of the iteration. */
  ramPeak: number | undefined;
  time: number;
}

export const summarizeIteration = (iteration: TestCaseIterationResult): IterationSummary => {
  const cpuUsagePerProcess = sortByCpuUsage(averageCpuUsagePerProcess(iteration.measures));
  const highCpuUsagePerProcess = getHighCpuUsage(iteration.measures);

  return {
    cpuUsagePerProcess,
    cpuUsage: sumCpuUsage(cpuUsagePerProcess),
    highCpuUsagePerProcess,
    totalHighCpuUsage: getAverageTotalHighCPUUsage(highCpuUsagePerProcess),
    fps: getAverageFPSUsage(iteration.measures),
    fpsMin: getLowestFPS(iteration.measures),
    ram: getAverageRAMUsage(iteration.measures),
    ramPeak: getPeakRAMUsage(iteration.measures),
    time: iteration.time,
  };
};
