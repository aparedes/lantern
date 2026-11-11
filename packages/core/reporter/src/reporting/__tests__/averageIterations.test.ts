import { describe, it, expect } from "bun:test";
import { average, averageHighCpuUsage, averageIterations } from "../averageIterations";
import { TestCaseIterationResult } from "@lantern/types";

const ITERATION_1: TestCaseIterationResult = {
  measures: [
    {
      cpu: {
        perCore: {},
        perName: {
          A: 50,
          B: 30,
        },
      },
      ram: 100,
      fps: 60,
      time: 500,
    },
    {
      cpu: {
        perCore: {},
        perName: {
          A: 100,
          B: 100,
        },
      },
      ram: 100,
      fps: 30,
      time: 1000,
    },
  ],
  time: 0,
  status: "SUCCESS",
};

const ITERATION_2: TestCaseIterationResult = {
  measures: [
    {
      cpu: {
        perCore: {},
        perName: {
          B: 70,
          C: 100,
        },
      },
      ram: 300,
      fps: 60,
      time: 500,
    },
    {
      cpu: {
        perCore: {},
        perName: {
          B: 70,
          C: 100,
        },
      },
      ram: 300,
      fps: 0,
      time: 1000,
    },
  ],
  time: 0,
  status: "SUCCESS",
};

it("average measures", () => {
  expect(averageIterations([ITERATION_1, ITERATION_2])).toEqual({
    measures: [
      {
        cpu: {
          perCore: {},
          perName: {
            A: 25,
            B: 50,
            C: 50,
          },
        },
        ram: 200,
        fps: 60,
        time: 0,
      },
      {
        cpu: {
          perCore: {},
          perName: {
            A: 50,
            B: 85,
            C: 50,
          },
        },
        ram: 200,
        fps: 15,
        time: 500,
      },
    ],
    time: 0,
    status: "SUCCESS",
  });
});

it("averages high CPU usage", () => {
  expect(averageHighCpuUsage([ITERATION_1, ITERATION_2])).toEqual({
    A: 250,
    B: 250,
    C: 500,
  });
});

describe("average", () => {
  it("averages numbers", () => {
    expect(average([1, 2, 3])).toBe(2);
  });

  it("skips undefined samples and divides by the number of defined ones", () => {
    expect(average([10, undefined, 30])).toBe(20);
    expect(average([undefined, 5])).toBe(5);
  });

  it("returns undefined when no sample is defined", () => {
    const undefinedSamples: (number | undefined)[] = [undefined, undefined];
    expect(average([])).toBeUndefined();
    expect(average(undefinedSamples)).toBeUndefined();
  });
});

describe("averageIterations", () => {
  it("truncates to the shortest iteration when lengths are uneven", () => {
    const averaged = averageIterations([
      ITERATION_1,
      { ...ITERATION_2, measures: ITERATION_2.measures.slice(0, 1) },
    ]);

    expect(averaged.measures).toHaveLength(1);
    expect(averaged.measures[0].cpu.perName).toEqual({ A: 25, B: 50, C: 50 });
  });

  it("averages FPS over the iterations that report it", () => {
    const withoutFps: TestCaseIterationResult = {
      ...ITERATION_2,
      measures: ITERATION_2.measures.map((measure) => ({ ...measure, fps: undefined })),
    };

    expect(averageIterations([ITERATION_1, withoutFps]).measures.map((m) => m.fps)).toEqual([
      60, 30,
    ]);
    expect(averageIterations([withoutFps]).measures.map((m) => m.fps)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("positions averaged samples at the mean offset of the iterations", () => {
    const at = (times: number[]): TestCaseIterationResult => ({
      ...ITERATION_1,
      measures: ITERATION_1.measures
        .concat(ITERATION_2.measures)
        .slice(0, times.length)
        .map((measure, i) => ({ ...measure, time: times[i] })),
    });
    // Offsets 0, 510 and 0, 1050 (the second one counted from the epoch)
    const epoch = 1788371317314;
    const averaged = averageIterations([at([0, 510]), at([epoch, epoch + 1050])]);

    expect(averaged.measures.map((m) => m.time)).toEqual([0, 780]);
  });

  it("returns no measures for no iterations", () => {
    const averaged = averageIterations([]);
    expect(averaged.measures).toEqual([]);
    expect(averaged.time).toBe(0);
  });
});
