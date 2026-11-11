import { describe, it, expect } from "bun:test";
import { ThreadNamer, processOutput } from "../getCpuStatsByProcess";

const SAMPLE_STATS = `27986 (OkHttp TaskRunn) S 480 480 0 0 -1 1077952576 6 0 0 0 50 20 40 0 20 0 53 0 233304293 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 5 0 0 0 0 0 0 0 0 0 0 0 0 0
27987 (FrescoDecodeExe) S 480 480 0 0 -1 1077952576 3966 0 0 0 23 3 7 0 30 10 53 0 233304298 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 2 0 0 0 0 0 0 0 0 0 0 0 0 0
27988 (content.com/...) S 480 480 0 0 -1 1077952576 396 0 0 0 28 5 5 0 20 0 53 0 233304298 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 5 0 0 0 0 0 0 0 0 0 0 0 0 0
1234 (com.example) S 480 480 0 0 -1 1077952576 396 0 0 0 28 5 5 0 20 0 53 0 233304298 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 5 0 0 0 0 0 0 0 0 0 0 0 0 0`;

describe("getCpuStatsByProcess", () => {
  it("extract CPU thread stats from profiler output", () => {
    expect(processOutput(SAMPLE_STATS, "1234")).toMatchInlineSnapshot(`
      [
        {
          "cpuNumber": "5",
          "processId": "27986",
          "processName": "OkHttp TaskRunn",
          "totalCpuTime": 70,
        },
        {
          "cpuNumber": "2",
          "processId": "27987",
          "processName": "FrescoDecodeExe",
          "totalCpuTime": 26,
        },
        {
          "cpuNumber": "5",
          "processId": "27988",
          "processName": "content.com/...",
          "totalCpuTime": 33,
        },
        {
          "cpuNumber": "5",
          "processId": "1234",
          "processName": "UI Thread",
          "totalCpuTime": 33,
        },
      ]
    `);
  });

  it("handles empty process name", () => {
    expect(
      processOutput(
        `10180 () S 901 901 0 0 -1 1077936192 2 362 0 12 0 0 0 0 10 -10 130 0 43243569 18565066752 83083 18446744073709551615 1 1 0 0 0 0 4612 1 1073779960 0 0 0 -1 3 0 0 0 0 0 0 0 0 0 0 0 0 0`,
        "1234"
      )
    ).toMatchInlineSnapshot(`
      [
        {
          "cpuNumber": "3",
          "processId": "10180",
          "processName": "Empty name",
          "totalCpuTime": 0,
        },
      ]
    `);
  });

  it("handles AWCN Worker(M)1 process name", () => {
    expect(
      processOutput(
        `16360 (AWCN Worker(M)1) S 372 372 0 0 -1 1077936192 70 0 3 0 0 0 0 0 20 0 35 0 58748 16236625920 43973 18446744073709551615 1 1 0 0 0 0 4608 1 1073775868 0 0 0 -1 2 0 0 0 0 0 0 0 0 0 0 0 0 0`,
        "1234"
      )
    ).toMatchInlineSnapshot(`
      [
        {
          "cpuNumber": "2",
          "processId": "16360",
          "processName": "AWCN Worker(M)1",
          "totalCpuTime": 0,
        },
      ]
    `);
  });
});

/** One `/proc/<pid>/task/<tid>/stat` line, with `cpuTime` ticks of utime. */
const statLine = (tid: string, name: string, cpuTime = 0) =>
  `${tid} (${name}) S 480 480 0 0 -1 1077952576 6 0 0 0 ${cpuTime} 0 40 0 20 0 53 0 233304293 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 5 0 0 0 0 0 0 0 0 0 0 0 0 0`;

const labelsOf = (namer: ThreadNamer, lines: string[]) =>
  Object.fromEntries(
    processOutput(lines.join("\n"), "1234", namer).map(({ processId, processName }) => [
      processId,
      processName,
    ])
  );

describe("ThreadNamer", () => {
  it("keeps each thread's label when the threads are listed in another order", () => {
    const namer = new ThreadNamer();

    expect(labelsOf(namer, [statLine("10", "OkHttp"), statLine("11", "OkHttp")])).toEqual({
      "10": "OkHttp",
      "11": "OkHttp (2)",
    });
    expect(labelsOf(namer, [statLine("11", "OkHttp"), statLine("10", "OkHttp")])).toEqual({
      "10": "OkHttp",
      "11": "OkHttp (2)",
    });
  });

  it("keeps no bookkeeping for names no live thread uses any more", () => {
    const namer = new ThreadNamer();
    const usedIndexes = (namer as unknown as { usedIndexes: Map<string, Set<number>> }).usedIndexes;

    for (let i = 0; i < 50; i++) {
      labelsOf(namer, [statLine("1", "Main"), statLine(`${100 + i}`, `Thread-${i}`)]);
    }

    expect([...usedIndexes.keys()]).toEqual(["Main", "Thread-49"]);
  });

  it("hands a freed label to a new thread while survivors keep theirs", () => {
    const namer = new ThreadNamer();

    labelsOf(namer, [statLine("10", "OkHttp"), statLine("11", "OkHttp")]);

    // 10 is gone, 12 is new
    expect(labelsOf(namer, [statLine("11", "OkHttp"), statLine("12", "OkHttp")])).toEqual({
      "11": "OkHttp (2)",
      "12": "OkHttp",
    });
  });

  it("labels a renamed thread under its new name and frees the old label", () => {
    const namer = new ThreadNamer();

    labelsOf(namer, [statLine("10", "Worker"), statLine("11", "Worker"), statLine("20", "Pool")]);

    // 10 renamed itself "Pool": it joins after 20, and "Worker" is free again for 12
    expect(
      labelsOf(namer, [
        statLine("10", "Pool"),
        statLine("11", "Worker"),
        statLine("12", "Worker"),
        statLine("20", "Pool"),
      ])
    ).toEqual({
      "10": "Pool (2)",
      "11": "Worker (2)",
      "12": "Worker",
      "20": "Pool",
    });
  });

  it("names a single sample like a fresh namer would", () => {
    const namer = new ThreadNamer();

    expect(
      namer.name([
        ["1", "A"],
        ["2", "A"],
        ["3", "B"],
        ["4", "A"],
      ])
    ).toEqual(["A", "A (2)", "B", "A (3)"]);
  });
});
