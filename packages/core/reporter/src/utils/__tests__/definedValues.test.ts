import { describe, it, expect } from "bun:test";
import { definedValues, maxOf, minOf } from "../definedValues";
import { getDefinedValuesStats, getValuesStats } from "../getValuesStats";

describe("definedValues", () => {
  it("drops the undefined entries and keeps 0", () => {
    expect(definedValues([3, undefined, 0, undefined, 1])).toEqual([3, 0, 1]);
  });
});

describe("minOf / maxOf", () => {
  it("skip undefined values", () => {
    expect(minOf([undefined, 30, 12, undefined, 58])).toBe(12);
    expect(maxOf([undefined, 30, 12, undefined, 58])).toBe(58);
  });

  it("are undefined when no value is defined", () => {
    expect(minOf([])).toBeUndefined();
    expect(maxOf([undefined, undefined])).toBeUndefined();
  });

  it("handle more samples than a function call takes arguments", () => {
    const values = Array.from({ length: 500_000 }, (_, i) => i);

    expect(minOf(values)).toBe(0);
    expect(maxOf(values)).toBe(499_999);
  });
});

describe("getDefinedValuesStats", () => {
  it("is the stats of the defined values", () => {
    expect(getDefinedValuesStats([10, undefined, 20], 15)).toEqual(getValuesStats([10, 20], 15));
  });

  it("is undefined without an average", () => {
    expect(getDefinedValuesStats([10, 20], undefined)).toBeUndefined();
  });
});
