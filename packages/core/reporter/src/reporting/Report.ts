import { TestCaseResult, AveragedTestCaseResult, TestCaseIterationResult } from "@lantern/types";
import { roundToDecimal } from "../utils/round";
import { average, averageTestCaseResult } from "./averageIterations";
import { getScore } from "./getScore";
import {
  getAverageCpuUsage,
  getAverageCpuUsagePerProcess,
  getCpuStats,
  getThreadsStats,
} from "./cpu";
import { getAverageFPSUsage, getFpsStats, getLowestFpsStats } from "./fps";
import { getAverageTotalHighCPUUsage, getHighCpuStats } from "./highCpu";
import { IterationSummary, summarizeIteration } from "./iterationSummary";
import { getAverageRAMUsage, getRamPeakStats, getRamStats } from "./ram";
import { getRuntimeStats } from "./runtime";

interface ReportMetrics {
  runtime: number;
  fps?: number;
  fpsMin?: number;
  cpu: number;
  totalHighCpuTime: number;
  ram?: number;
  ramPeak?: number;
  averageCpuUsagePerProcess: {
    cpuUsage: number;
    processName: string;
  }[];
}

export interface ReportStats {
  cpu: ReturnType<typeof getCpuStats>;
  fps: ReturnType<typeof getFpsStats>;
  fpsMin: ReturnType<typeof getLowestFpsStats>;
  highCpu: ReturnType<typeof getHighCpuStats>;
  ram: ReturnType<typeof getRamStats>;
  ramPeak: ReturnType<typeof getRamPeakStats>;
  runtime: ReturnType<typeof getRuntimeStats>;
  threads: ReturnType<typeof getThreadsStats>;
}

export class Report {
  /** The raw result, including failed iterations. */
  private result: TestCaseResult;
  /**
   * The iterations the averages, the stats and the iteration selector are computed over: the
   * ones not explicitly marked as failed (legacy result files carry no status). When every
   * iteration failed (retries exhausted) they are all kept instead, so that the failed run's
   * measures and videos can still be inspected next to the other reports.
   */
  private reportedIterations: TestCaseIterationResult[];
  private iterationSummaries: IterationSummary[];
  private averagedResult: AveragedTestCaseResult;
  private averageMetrics: ReportMetrics;
  private cachedScore: number | undefined;
  private cachedStats: ReportStats | undefined;

  constructor(result: TestCaseResult) {
    this.result = result;
    const successfulIterations = result.iterations.filter(
      (iteration) => iteration.status !== "FAILURE"
    );
    this.reportedIterations =
      successfulIterations.length > 0 ? successfulIterations : result.iterations;
    this.iterationSummaries = this.reportedIterations.map(summarizeIteration);
    this.averagedResult = averageTestCaseResult({
      ...result,
      iterations: this.reportedIterations,
    });
    this.averageMetrics = Report.getAverageMetrics(this.averagedResult, this.iterationSummaries);
  }

  private static getAverageMetrics(
    averagedResult: AveragedTestCaseResult,
    iterationSummaries: IterationSummary[]
  ): ReportMetrics {
    const averageTestRuntime = roundToDecimal(averagedResult.average.time, 0);
    const averageFPS = getAverageFPSUsage(averagedResult.average.measures);
    const averageCPU = roundToDecimal(getAverageCpuUsage(averagedResult.average.measures), 1);
    const averageTotalHighCPU = roundToDecimal(
      getAverageTotalHighCPUUsage(averagedResult.averageHighCpuUsage) / 1000,
      1
    );
    const averageRAM = getAverageRAMUsage(averagedResult.average.measures);
    const lowestFPS = average(iterationSummaries.map((summary) => summary.fpsMin));
    const peakRAM = average(iterationSummaries.map((summary) => summary.ramPeak));

    return {
      runtime: averageTestRuntime,
      fps: averageFPS !== undefined ? roundToDecimal(averageFPS, 1) : undefined,
      fpsMin: lowestFPS !== undefined ? roundToDecimal(lowestFPS, 1) : undefined,
      cpu: averageCPU,
      totalHighCpuTime: averageTotalHighCPU,
      ram: averageRAM !== undefined ? roundToDecimal(averageRAM, 1) : undefined,
      ramPeak: peakRAM !== undefined ? roundToDecimal(peakRAM, 1) : undefined,
      averageCpuUsagePerProcess: getAverageCpuUsagePerProcess(averagedResult.average.measures),
    };
  }

  public get name() {
    return this.result.name;
  }

  public get status() {
    return this.result.status;
  }

  public get score() {
    this.cachedScore ??= this.averagedResult.score ?? getScore(this.averagedResult);
    return this.cachedScore;
  }

  public getIterationCount() {
    return this.reportedIterations.length;
  }

  public hasMeasures() {
    return this.reportedIterations[0]?.measures.length > 0;
  }

  public hasVideos() {
    return !!this.reportedIterations[0]?.videoInfos;
  }

  /** A report over the single reported iteration at `iterationIndex`, or over none if out of bounds. */
  public selectIteration(iterationIndex: number): Report {
    const isInBounds = iterationIndex >= 0 && iterationIndex < this.reportedIterations.length;

    return new Report({
      ...this.result,
      iterations: isInBounds ? [this.reportedIterations[iterationIndex]] : [],
    });
  }

  public getAveragedResult() {
    return this.averagedResult;
  }

  public getAverageMetrics() {
    return this.averageMetrics;
  }

  public getStats(): ReportStats {
    this.cachedStats ??= {
      cpu: getCpuStats(this.iterationSummaries, this.averageMetrics.cpu),
      fps: getFpsStats(this.iterationSummaries, this.averageMetrics.fps),
      fpsMin: getLowestFpsStats(this.iterationSummaries, this.averageMetrics.fpsMin),
      highCpu: getHighCpuStats(this.iterationSummaries, this.averagedResult.averageHighCpuUsage),
      ram: getRamStats(this.iterationSummaries, this.averageMetrics.ram),
      ramPeak: getRamPeakStats(this.iterationSummaries, this.averageMetrics.ramPeak),
      runtime: getRuntimeStats(this.iterationSummaries, this.averageMetrics.runtime),
      threads: getThreadsStats(this.iterationSummaries),
    };
    return this.cachedStats;
  }

  /** The device the result was measured on, when the result file recorded it. */
  public getSpecs() {
    return this.result.specs;
  }

  public getRefreshRate() {
    return this.result.specs?.refreshRate ?? 60;
  }
}
