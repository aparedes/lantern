import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { setJsonMode } from "@lantern/cli-core";
import { Logger } from "@lantern/logger";
import { TestCaseResult } from "@lantern/types";
import { registerReportCommand, shouldOpenReport } from "../command";

const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
spyOn(Logger, "success").mockImplementation(() => {});

let workDir: string;
const originalAssetsPath = process.env.LANTERN_REPORT_ASSETS_PATH;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-report-command-"));
  const assetsDir = path.join(workDir, "assets");
  fs.mkdirSync(assetsDir);
  fs.writeFileSync(
    path.join(assetsDir, "index.html"),
    `<script>const results = "THIS_IS_A_VERY_LONG_STRING_THAT_IS_UNLIKELY_TO_BE_FOUND_IN_A_TEST_CASE_RESULT";</script>`
  );
  process.env.LANTERN_REPORT_ASSETS_PATH = assetsDir;

  const result: TestCaseResult = { name: "Results", status: "SUCCESS", iterations: [] };
  fs.writeFileSync(path.join(workDir, "results.json"), JSON.stringify(result));
});

afterEach(() => {
  stdout.mockClear();
  setJsonMode(false);
});

afterAll(() => {
  if (originalAssetsPath === undefined) delete process.env.LANTERN_REPORT_ASSETS_PATH;
  else process.env.LANTERN_REPORT_ASSETS_PATH = originalAssetsPath;
  fs.rmSync(workDir, { recursive: true, force: true });
  mock.restore();
});

const runReport = (...args: string[]) => {
  const program = new Command("lantern").exitOverride();
  registerReportCommand(program);

  return program.parseAsync(["report", ...args], { from: "user" });
};

describe("shouldOpenReport", () => {
  it("opens in an interactive terminal outside CI", () => {
    expect(shouldOpenReport(true, { isTTY: true, ci: undefined })).toBe(true);
    expect(shouldOpenReport(true, { isTTY: true, ci: "false" })).toBe(true);
  });

  it("does not open with --no-open, without a terminal, or in CI", () => {
    expect(shouldOpenReport(false, { isTTY: true, ci: undefined })).toBe(false);
    expect(shouldOpenReport(true, { isTTY: false, ci: undefined })).toBe(false);
    expect(shouldOpenReport(true, { isTTY: true, ci: "true" })).toBe(false);
  });
});

describe("lantern report", () => {
  it("writes the report and prints its path as JSON", async () => {
    const outputDir = path.join(workDir, "out");
    setJsonMode(true);

    await runReport(path.join(workDir, "results.json"), "-o", outputDir, "--no-open");

    const htmlPath = path.join(outputDir, "report.html");
    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({ htmlPath })}\n`);
  });

  it("rejects missing results files with INVALID_ARGUMENT", async () => {
    const missing = path.join(workDir, "nope.json");

    await expect(runReport(missing, "--no-open")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: `No such file or folder: ${missing}`,
      details: { missingPaths: [missing] },
    });
  });
});
