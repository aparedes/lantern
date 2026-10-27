import fs from "fs";
import os from "os";
import path from "path";
import { Command, Option } from "commander";
import { Logger } from "@lantern/logger";
import { printResult, registerJsonOption } from "@lantern/cli-core";
import { open } from "@lantern/shell";
import { parseDuration, parseSkip } from "./optionParsers";
import { getReportFileName, writeReport } from "./writeReport";

/**
 * Whether to open the report in a browser: not when asked not to (`--no-open`), nor when nobody
 * is there to look at it (stdout is not a terminal, or `CI` is set).
 */
export const shouldOpenReport = (
  openFlag: boolean,
  { isTTY = process.stdout.isTTY, ci = process.env.CI } = {}
) => openFlag && Boolean(isTTY) && (ci === undefined || ci === "" || ci === "false");

export const registerReportCommand = (program: Command) => {
  const reportCommand = program
    .command("report")
    .argument("<files/folders...>")
    .summary("Generate web report from performance measures.")
    .description(
      `Generate web report from performance measures.

Examples:
lantern report results1.json
lantern report results1.json results2.json -o output-dir
lantern report results1.json --skip 1500 --duration 10000
lantern report results1.json --no-open --json
`
    )
    .option("-o, --output-dir <outputDir>", "Output directory for the web report")
    .addOption(
      new Option(
        "-d, --duration <duration>",
        `Duration in ms of measures to analyze in report. If measures are longer than that, they'll be "cut".`
      ).argParser(parseDuration)
    )
    .addOption(
      new Option("-s, --skip <skip>", "Skip first ms of measures in report").argParser(parseSkip)
    )
    .option(
      "--no-open",
      "Only write the report, do not open it (implied when stdout is not a terminal or CI is set)"
    );

  registerJsonOption(reportCommand).action(
    (
      jsonPaths: string[],
      options: { outputDir?: string; duration?: number; skip?: number; open: boolean }
    ) => {
      const outputDir = options.outputDir || os.tmpdir();
      // With `-o` the user owns the folder and `report.html` is overwritten as before. Otherwise
      // reports share the temp dir, so give each a name that does not clobber a previous one.
      const fileName = options.outputDir
        ? "report.html"
        : getReportFileName({
            firstJsonPath: jsonPaths[0],
            exists: (name) => fs.existsSync(path.join(outputDir, name)),
          });

      const htmlFilePath = writeReport({
        outputDir,
        jsonPaths,
        duration: options.duration ?? null,
        skip: options.skip ?? 0,
        fileName,
      });

      if (shouldOpenReport(options.open)) {
        Logger.success(`Opening report: ${htmlFilePath}`);
        open(htmlFilePath);
      } else {
        Logger.success(`Report written to ${htmlFilePath}`);
      }

      printResult({ htmlPath: htmlFilePath });
    }
  );
};
