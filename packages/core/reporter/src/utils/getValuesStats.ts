import { definedValues } from "./definedValues";
import { getMinMax } from "./getMinMax";
import { getStandardDeviation } from "./getStandardDeviation";
import { variationCoefficient } from "./variationCoefficient";

export interface ValuesStats {
  minMaxRange: [number, number];
  deviationRange: [number, number];
  variationCoefficient: number;
}

/**
 * Dispersion stats of one value per iteration. `average` is the displayed average the
 * coefficient of variation is expressed against; the deviation range itself is centered on
 * the mean of `values`.
 */
export const getValuesStats = (values: number[], average: number): ValuesStats => {
  const standardDeviation = getStandardDeviation({ values });

  return {
    minMaxRange: getMinMax(values),
    deviationRange: standardDeviation.deviationRange,
    variationCoefficient: variationCoefficient(average, standardDeviation.deviation),
  };
};

/**
 * `getValuesStats` over the iterations that have the value. Undefined when there is no average
 * to express them against, i.e. when no iteration has it.
 */
export const getDefinedValuesStats = (
  values: (number | undefined)[],
  average: number | undefined
): ValuesStats | undefined =>
  average === undefined ? undefined : getValuesStats(definedValues(values), average);

export const getStatsByThread = (valuesByThread: {
  [threadName: string]: number[];
}): { [threadName: string]: ValuesStats } => {
  const statsByThread: { [threadName: string]: ValuesStats } = {};

  Object.keys(valuesByThread).forEach((threadName) => {
    const threadValues = valuesByThread[threadName];
    const threadAverage = threadValues.reduce((sum, value) => sum + value, 0) / threadValues.length;
    statsByThread[threadName] = getValuesStats(threadValues, threadAverage);
  });

  return statsByThread;
};
