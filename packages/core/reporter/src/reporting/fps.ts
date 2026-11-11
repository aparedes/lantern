import { Measure } from "@lantern/types";
import { definedValues, minOf } from "../utils/definedValues";
import { getStandardDeviation } from "../utils/getStandardDeviation";
import { getDefinedValuesStats } from "../utils/getValuesStats";
import { average } from "./averageIterations";
import type { IterationSummary } from "./iterationSummary";

export const getAverageFPSUsage = (measures: Measure[]) =>
  average(measures.map((measure) => measure.fps));

export const getStandardDeviationFPS = (iterations: IterationSummary[]) =>
  getStandardDeviation({ values: definedValues(iterations.map((iteration) => iteration.fps)) });

export const getFpsStats = (iterations: IterationSummary[], averageFps?: number) =>
  getDefinedValuesStats(
    iterations.map((iteration) => iteration.fps),
    averageFps
  );

/** The lowest FPS sample, or undefined when no sample carries one. */
export const getLowestFPS = (measures: Measure[]) => minOf(measures.map((measure) => measure.fps));

export const getLowestFpsStats = (iterations: IterationSummary[], averageLowestFps?: number) =>
  getDefinedValuesStats(
    iterations.map((iteration) => iteration.fpsMin),
    averageLowestFps
  );
