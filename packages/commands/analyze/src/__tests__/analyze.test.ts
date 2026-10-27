import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { setJsonMode } from "@lantern/cli-core";
import { POLLING_INTERVAL, TestCaseResult } from "@lantern/types";
import { readResults, registerSummarizeCommand, resolveResultsPaths } from "..";

const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
const consoleLog = spyOn(console, "log").mockImplementation(() => {});

const result = (name: string): TestCaseResult => ({
  name,
  status: "SUCCESS",
  iterations: [1, 2, 3].map(() => ({
    time: 1000,
    status: "SUCCESS" as const,
    measures: [{ cpu: { perCore: {}, perName: { UI: 20 } }, fps: 60, time: POLLING_INTERVAL }],
  })),
  specs: { refreshRate: 60 },
});

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-analyze-"));
  fs.mkdirSync(path.join(dir, "folder"));
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(result("a")));
  fs.writeFileSync(path.join(dir, "folder", "b.json"), JSON.stringify(result("b")));
  fs.writeFileSync(path.join(dir, "folder", "notes.txt"), "not results");
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ hello: "world" }));
});

afterEach(() => {
  stdout.mockClear();
  consoleLog.mockClear();
  setJsonMode(false);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

describe("resolveResultsPaths", () => {
  it("keeps files and expands folders to their .json files", () => {
    expect(resolveResultsPaths([path.join(dir, "a.json"), path.join(dir, "folder")])).toEqual([
      path.join(dir, "a.json"),
      path.join(dir, "folder", "b.json"),
    ]);
  });

  it("rejects missing paths with INVALID_ARGUMENT, naming them", () => {
    const missing = path.join(dir, "nope.json");

    expect(() => resolveResultsPaths([path.join(dir, "a.json"), missing])).toThrow(
      `No such file or folder: ${missing}`
    );
    try {
      resolveResultsPaths([missing]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { missingPaths: [missing] },
      });
    }
  });
});

describe("readResults", () => {
  it("reads each results file with its path", () => {
    expect(readResults([path.join(dir, "a.json")])).toEqual([
      { path: path.join(dir, "a.json"), result: result("a") },
    ]);
  });

  it("rejects invalid JSON and files that are not results", () => {
    expect(() => readResults([path.join(dir, "broken.json")])).toThrow(/is not valid JSON/);
    expect(() => readResults([path.join(dir, "other.json")])).toThrow(
      /is not a lantern results file/
    );
  });
});

describe("lantern summarize", () => {
  const runSummarize = (...args: string[]) => {
    const program = new Command("lantern").exitOverride();
    registerSummarizeCommand(program);
    // Commander prints the usage errors the tests trigger on purpose
    program.commands.forEach((command) => command.configureOutput({ writeErr: () => {} }));

    return program.parseAsync(["summarize", ...args], { from: "user" });
  };

  it("prints one summary per results file as JSON", async () => {
    setJsonMode(true);

    await runSummarize(path.join(dir, "a.json"), path.join(dir, "folder"), "--top", "1");

    expect(stdout).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(
      output.map(({ path: file, name }: { path: string; name: string }) => [file, name])
    ).toEqual([
      [path.join(dir, "a.json"), "a"],
      [path.join(dir, "folder", "b.json"), "b"],
    ]);
    expect(output[0]).toMatchObject({
      schemaVersion: 1,
      score: expect.any(Number),
      cpu: { avg: 20, n: 3 },
      topThreads: [{ name: "UI", avgCpu: 20, highCpuSeconds: 0 }],
    });
  });

  it("prints a human-readable summary otherwise", async () => {
    await runSummarize(path.join(dir, "a.json"));

    expect(stdout).not.toHaveBeenCalled();
    expect(String(consoleLog.mock.calls[0][0])).toContain("a: SUCCESS, score");
    expect(String(consoleLog.mock.calls[0][0])).toContain(`File: ${path.join(dir, "a.json")}`);
  });

  it("rejects a bad --top", async () => {
    await expect(runSummarize(path.join(dir, "a.json"), "--top", "-1")).rejects.toThrow(
      /non-negative integer/
    );
  });
});
