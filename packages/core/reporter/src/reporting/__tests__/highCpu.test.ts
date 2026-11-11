import { describe, it, expect } from "bun:test";
import { Measure } from "@lantern/types";
import { getAverageTotalHighCPUUsage, getHighCpuUsage, getThreadLockedRatio } from "../highCpu";
import { getMeasuresDuration } from "../timeline";

const measure = (time: number, perName: { [threadName: string]: number }): Measure => ({
  cpu: { perCore: {}, perName },
  time,
});

describe("getThreadLockedRatio", () => {
  it("is the share of polls above the threshold when they are evenly spaced", () => {
    const measures = [
      measure(500, { UI: 95 }),
      measure(1000, { UI: 10 }),
      measure(1500, { UI: 10, JS: 99 }),
      measure(2000, { UI: 10 }),
    ];

    expect(getThreadLockedRatio(measures)).toBe(0.5);
  });

  it("counts two busy threads of one poll once", () => {
    expect(getThreadLockedRatio([measure(500, { UI: 95, JS: 99 }), measure(1000, {})])).toBe(0.5);
  });

  it("weighs each poll by the time it covers, in line with the high CPU time", () => {
    // The locked sample took 3 s to come: 3 s out of the 4.5 s measured
    const measures = [
      measure(500, { UI: 10 }),
      measure(1000, { UI: 10 }),
      measure(4000, { UI: 95 }),
      measure(4500, { UI: 10 }),
    ];

    expect(getThreadLockedRatio(measures)).toBeCloseTo(3000 / 4500);
    expect(getThreadLockedRatio(measures) * getMeasuresDuration(measures)).toBeCloseTo(
      getAverageTotalHighCPUUsage(getHighCpuUsage(measures))
    );
  });

  it("is 0 without measures", () => {
    expect(getThreadLockedRatio([])).toBe(0);
  });
});
