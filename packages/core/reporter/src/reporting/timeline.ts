import { Measure, POLLING_INTERVAL } from "@lantern/types";

/**
 * Whether `time` can position the samples: finite and strictly increasing. Result files from
 * older versions carry a constant, and averaged legacy samples a fixed `POLLING_INTERVAL`.
 */
const hasUsableTimes = (measures: Measure[]) =>
  measures.every(
    (measure, i) =>
      Number.isFinite(measure.time) && (i === 0 || measure.time > measures[i - 1].time)
  );

/**
 * Milliseconds of each measure from the first one. Independent of what `time` is counted
 * from (session start, or the epoch in older iOS files). Falls back to one polling interval
 * per sample when the times are unusable.
 */
export const getMeasureOffsets = (measures: Measure[]): number[] =>
  hasUsableTimes(measures)
    ? measures.map((measure) => measure.time - measures[0].time)
    : measures.map((_, i) => i * POLLING_INTERVAL);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * How long each measure covers, in ms: the time since the previous one. The first measure
 * has no predecessor, so it gets the median of the others. Falls back to the polling
 * interval when the times are unusable or there is a single measure.
 */
export const getMeasureDurations = (measures: Measure[]): number[] => {
  if (measures.length < 2 || !hasUsableTimes(measures)) {
    return measures.map(() => POLLING_INTERVAL);
  }

  const gaps = measures.slice(1).map((measure, i) => measure.time - measures[i].time);

  return [median(gaps), ...gaps];
};

/** How long the measures cover in total, in ms: the sum of `getMeasureDurations`. */
export const getMeasuresDuration = (measures: Measure[]): number =>
  getMeasureDurations(measures).reduce((sum, duration) => sum + duration, 0);

/**
 * The measures of a time window: `duration` ms (to the end when null) starting `skip` ms after
 * the first measure. Samples never land exactly on the polling interval, so one within half an
 * interval of a bound counts as being on it. When the times are unusable this is a cut by
 * sample count, one polling interval per sample.
 */
export const sliceMeasuresByTime = (
  measures: Measure[],
  { skip = 0, duration }: { skip?: number; duration: number | null }
): Measure[] => {
  const offsets = getMeasureOffsets(measures);
  const tolerance = POLLING_INTERVAL / 2;
  const from = skip - tolerance;
  const to = duration === null ? Infinity : skip + duration + tolerance;

  return measures.filter((_, i) => offsets[i] >= from && offsets[i] <= to);
};
