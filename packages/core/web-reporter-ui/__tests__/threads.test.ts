import { describe, it, expect } from "bun:test";
import { Measure, TestCaseResult } from "@lantern/types";
import { mapThreadNames } from "../src/sections/threads";

const aMeasure = (perName: { [name: string]: number }): Measure => ({
  cpu: { perName, perCore: {} },
  ram: 100,
  time: 500,
});

const resultWith = (measures: Measure[]): TestCaseResult => ({
  name: "com.example",
  status: "SUCCESS",
  iterations: [{ measures, time: 500, status: "SUCCESS" }],
});

describe("mapThreadNames", () => {
  it("maps known thread names and keeps the others", () => {
    const [result] = mapThreadNames([
      resultWith([aMeasure({ mqt_js: 10, "1.ui": 20, "UI Thread": 30 })]),
    ]);

    const measure = result.iterations[0].measures[0];
    expect(measure.cpu.perName).toEqual({
      "RN JS Thread": 10,
      "Flutter UI Thread": 20,
      "UI Thread": 30,
    });
    expect(measure.ram).toBe(100);
    expect(measure.time).toBe(500);
  });

  it("does not touch its input", () => {
    const measure = aMeasure({ mqt_js: 10 });
    mapThreadNames([resultWith([measure])]);

    expect(measure.cpu.perName).toEqual({ mqt_js: 10 });
  });

  it("maps the same measure object to the same output object across calls", () => {
    const measure = aMeasure({ mqt_js: 10 });
    const other = aMeasure({ mqt_js: 20 });

    const first = mapThreadNames([resultWith([measure])]);
    const second = mapThreadNames([resultWith([measure, other])]);

    expect(second[0].iterations[0].measures[0]).toBe(first[0].iterations[0].measures[0]);
    expect(second[0].iterations[0].measures[1]).not.toBe(second[0].iterations[0].measures[0]);
  });

  it("keeps the later key's value when two names map to the same one", () => {
    const [result] = mapThreadNames([resultWith([aMeasure({ mqt_js: 10, mqt_v_js: 30 })])]);

    expect(result.iterations[0].measures[0].cpu.perName).toEqual({ "RN JS Thread": 30 });
  });
});
