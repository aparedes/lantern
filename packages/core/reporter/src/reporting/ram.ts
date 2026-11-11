import { Measure } from "@lantern/types";
import { maxOf } from "../utils/definedValues";
import { getDefinedValuesStats } from "../utils/getValuesStats";
import { average } from "./averageIterations";
import type { IterationSummary } from "./iterationSummary";

export const getAverageRAMUsage = (measures: Measure[]) =>
  average(measures.map((measure) => measure.ram));

export const getRamStats = (iterations: IterationSummary[], averageRam?: number) =>
  getDefinedValuesStats(
    iterations.map((iteration) => iteration.ram),
    averageRam
  );

/** The highest RAM sample, or undefined when no sample carries one. */
export const getPeakRAMUsage = (measures: Measure[]) =>
  maxOf(measures.map((measure) => measure.ram));

export const getRamPeakStats = (iterations: IterationSummary[], averagePeakRam?: number) =>
  getDefinedValuesStats(
    iterations.map((iteration) => iteration.ramPeak),
    averagePeakRam
  );
