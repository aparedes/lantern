import { describe, it, expect } from "bun:test";
import { Measure, POLLING_INTERVAL } from "@lantern/types";
import {
  getMeasureDurations,
  getMeasureOffsets,
  getMeasuresDuration,
  sliceMeasuresByTime,
} from "../timeline";

const measuresAt = (...times: number[]): Measure[] =>
  times.map((time) => ({ cpu: { perCore: {}, perName: {} }, time }));

describe("getMeasureOffsets", () => {
  it("returns the time since the first measure", () => {
    expect(getMeasureOffsets(measuresAt(0, 510, 1020, 1530))).toEqual([0, 510, 1020, 1530]);
    expect(getMeasureOffsets(measuresAt(1000, 1510, 2100))).toEqual([0, 510, 1100]);
  });

  it("does not depend on what the times are counted from", () => {
    const epoch = 1788371317314;

    expect(getMeasureOffsets(measuresAt(epoch, epoch + 505, epoch + 1020))).toEqual([0, 505, 1020]);
  });

  it("falls back to one polling interval per sample for constant times", () => {
    expect(getMeasureOffsets(measuresAt(500, 500, 500))).toEqual([
      0,
      POLLING_INTERVAL,
      2 * POLLING_INTERVAL,
    ]);
  });

  it("falls back for decreasing or non-finite times", () => {
    const expected = [0, POLLING_INTERVAL, 2 * POLLING_INTERVAL];

    expect(getMeasureOffsets(measuresAt(0, 1000, 500))).toEqual(expected);
    expect(getMeasureOffsets(measuresAt(0, Number.NaN, 1000))).toEqual(expected);
    expect(getMeasureOffsets(measuresAt(0, 500, Number.POSITIVE_INFINITY))).toEqual(expected);
    expect(getMeasureOffsets(measuresAt(Number.NaN, 500, 1000))).toEqual(expected);
  });

  it("handles a single measure and no measure", () => {
    expect(getMeasureOffsets(measuresAt(123456))).toEqual([0]);
    expect(getMeasureOffsets([])).toEqual([]);
  });
});

describe("getMeasureDurations", () => {
  it("is the gap to the previous measure, the first one getting the median gap", () => {
    expect(getMeasureDurations(measuresAt(0, 510, 1020, 1530))).toEqual([510, 510, 510, 510]);
    // Gaps 400, 600, 500: median 500
    expect(getMeasureDurations(measuresAt(0, 400, 1000, 1500))).toEqual([500, 400, 600, 500]);
    // Even number of gaps: mean of the two middle ones
    expect(getMeasureDurations(measuresAt(0, 400, 1000))).toEqual([500, 400, 600]);
  });

  it("works with epoch-sized times", () => {
    const epoch = 1788371317314;

    expect(getMeasureDurations(measuresAt(epoch, epoch + 500, epoch + 1010))).toEqual([
      505, 500, 510,
    ]);
  });

  it("falls back to the polling interval for unusable times", () => {
    expect(getMeasureDurations(measuresAt(500, 500, 500))).toEqual([
      POLLING_INTERVAL,
      POLLING_INTERVAL,
      POLLING_INTERVAL,
    ]);
    expect(getMeasureDurations(measuresAt(0, 1000, 500))).toEqual([
      POLLING_INTERVAL,
      POLLING_INTERVAL,
      POLLING_INTERVAL,
    ]);
    expect(getMeasureDurations(measuresAt(0, Number.NaN))).toEqual([
      POLLING_INTERVAL,
      POLLING_INTERVAL,
    ]);
  });

  it("uses the polling interval for a single measure, and returns nothing for none", () => {
    expect(getMeasureDurations(measuresAt(42))).toEqual([POLLING_INTERVAL]);
    expect(getMeasureDurations([])).toEqual([]);
  });
});

describe("getMeasuresDuration", () => {
  it("is the time the measures cover, the first one counting for the median gap", () => {
    expect(getMeasuresDuration(measuresAt(500, 1010, 1520))).toBe(1530);
    // A stalled sample covers its whole gap
    expect(getMeasuresDuration(measuresAt(500, 1000, 4000, 4500))).toBe(4500);
  });

  it("is one polling interval per sample for unusable times, and 0 without measures", () => {
    expect(getMeasuresDuration(measuresAt(500, 500, 500))).toBe(3 * POLLING_INTERVAL);
    expect(getMeasuresDuration([])).toBe(0);
  });
});

describe("sliceMeasuresByTime", () => {
  const timesOf = (measures: Measure[]) => measures.map((measure) => measure.time);

  it("keeps everything without a skip or a duration", () => {
    const measures = measuresAt(500, 1003, 1507);

    expect(sliceMeasuresByTime(measures, { duration: null })).toEqual(measures);
  });

  it("cuts by time since the first measure, jitter included", () => {
    // Offsets 0, 503, 1007, 1510, 2013, 2516
    const measures = measuresAt(500, 1003, 1507, 2010, 2513, 3016);

    expect(timesOf(sliceMeasuresByTime(measures, { skip: 500, duration: 1000 }))).toEqual([
      1003, 1507, 2010,
    ]);
    expect(timesOf(sliceMeasuresByTime(measures, { skip: 2000, duration: null }))).toEqual([
      2513, 3016,
    ]);
  });

  it("does not count a stalled sample as one polling interval", () => {
    // The third sample came 3 s late: 2 s of run hold two samples, not five
    const measures = measuresAt(500, 1000, 4000, 4500, 5000);

    expect(timesOf(sliceMeasuresByTime(measures, { duration: 2000 }))).toEqual([500, 1000]);
  });

  it("cuts by sample count when the times are unusable", () => {
    const measures = measuresAt(7, 7, 7, 7, 7);

    expect(sliceMeasuresByTime(measures, { skip: 500, duration: 1000 })).toEqual(
      measures.slice(1, 4)
    );
    expect(sliceMeasuresByTime(measures, { duration: 1000 })).toHaveLength(3);
  });
});
