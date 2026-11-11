import { Measure } from "@lantern/types";
import { getValuesStats } from "../utils/getValuesStats";
import { average } from "./averageIterations";
import type { IterationSummary } from "./iterationSummary";

export const getAverageRAMUsage = (measures: Measure[]) =>
  average(measures.map((measure) => measure.ram));

export const getRamStats = (iterations: IterationSummary[], averageRam?: number) => {
  if (averageRam === undefined) return undefined;

  const values = iterations.flatMap((iteration) =>
    iteration.ram !== undefined ? [iteration.ram] : []
  );

  return getValuesStats(values, averageRam);
};

/** The highest RAM sample, or undefined when no sample carries one. */
export const getPeakRAMUsage = (measures: Measure[]) => {
  const values = measures.flatMap((measure) => (measure.ram !== undefined ? [measure.ram] : []));

  return values.length > 0 ? Math.max(...values) : undefined;
};

export const getRamPeakStats = (iterations: IterationSummary[], averagePeakRam?: number) => {
  if (averagePeakRam === undefined) return undefined;

  return getValuesStats(
    iterations.flatMap((iteration) => (iteration.ramPeak !== undefined ? [iteration.ramPeak] : [])),
    averagePeakRam
  );
};
