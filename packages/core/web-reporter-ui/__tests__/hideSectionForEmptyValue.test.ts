import { describe, it, expect } from "bun:test";
import { AveragedTestCaseResult, Measure, POLLING_INTERVAL } from "@lantern/types";
import { buildValueGraph, hasValueForSomeMeasure } from "../src/sections/hideSectionForEmptyValue";

const aMeasure = (values: { fps?: number; ram?: number }): Measure => ({
  cpu: { perName: {}, perCore: {} },
  ...values,
  time: 0,
});

const aResult = (name: string, measures: Measure[]): AveragedTestCaseResult =>
  ({
    name,
    status: "SUCCESS",
    iterations: [],
    average: { measures, time: measures.length * POLLING_INTERVAL, status: "SUCCESS" },
  }) as unknown as AveragedTestCaseResult;

describe("hasValueForSomeMeasure", () => {
  it("is true as soon as one measure of one result has the stat, gaps included", () => {
    const results = [
      aResult("a", [aMeasure({ ram: 200 }), aMeasure({ ram: 200 })]),
      aResult("b", [aMeasure({}), aMeasure({ fps: 30 }), aMeasure({})]),
    ];

    expect(hasValueForSomeMeasure(results, "fps")).toBe(true);
  });

  it("is false when no measure carries the stat, and true once one does", () => {
    const withoutFps = [aResult("a", [aMeasure({ ram: 200 }), aMeasure({ ram: 201 })])];
    expect(hasValueForSomeMeasure(withoutFps, "fps")).toBe(false);

    // Nothing latches: the same call with a value present passes.
    const withFps = [aResult("a", [aMeasure({ ram: 200 }), aMeasure({ ram: 201, fps: 59 })])];
    expect(hasValueForSomeMeasure(withFps, "fps")).toBe(true);
  });

  it("is false for no results at all", () => {
    expect(hasValueForSomeMeasure([], "ram")).toBe(false);
  });
});

describe("buildValueGraph", () => {
  it("builds one rounded data point per measure, on the polling interval", () => {
    const results = [aResult("a", [aMeasure({ ram: 100.4 }), aMeasure({ ram: 120.6 })])];

    expect(buildValueGraph({ results, stat: "ram" })).toEqual([
      {
        name: "a",
        data: [
          { x: 0, y: 100 },
          { x: POLLING_INTERVAL, y: 121 },
        ],
      },
    ]);
  });

  it("emits an explicit null point (a chart gap) when a measure misses the stat", () => {
    const results = [aResult("a", [aMeasure({ fps: 60 }), aMeasure({}), aMeasure({ fps: 30 })])];

    expect(buildValueGraph({ results, stat: "fps" })).toEqual([
      {
        name: "a",
        data: [
          { x: 0, y: 60 },
          // Kept, not dropped: dropping it would make the line interpolate across the hole
          { x: POLLING_INTERVAL, y: null },
          { x: 2 * POLLING_INTERVAL, y: 30 },
        ],
      },
    ]);
  });

  it("positions the points on the real time of each measure when it increases", () => {
    const results = [
      aResult("a", [
        { ...aMeasure({ ram: 100 }), time: 510 },
        { ...aMeasure({ ram: 110 }), time: 1021 },
        { ...aMeasure({ ram: 120 }), time: 1533 },
      ]),
    ];

    expect(buildValueGraph({ results, stat: "ram" })[0].data.map((point) => point.x)).toEqual([
      0, 511, 1023,
    ]);
  });
});
