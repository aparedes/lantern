import { Command, InvalidArgumentError, Option } from "commander";
import { printResult, registerJsonOption } from "@lantern/cli-core";
import { ResultSummary, formatResultSummary, summarizeResult } from "@lantern/reporter";
import { readResults } from "./readResults";

const parseTopThreads = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
};

export type SummarizeOutput = (ResultSummary & { path: string })[];

export const registerSummarizeCommand = (program: Command) => {
  const summarizeCommand = program
    .command("summarize")
    .argument("<files/folders...>")
    .summary("Print the key numbers of results files")
    .description(
      `Print the key numbers of results files: score, CPU, FPS, RAM, high CPU time and busiest
threads, with their spread across iterations. The numbers are the ones the HTML report shows.

Examples:
lantern summarize results.json
lantern summarize results-folder --json
`
    )
    .addOption(
      new Option("--top <count>", "How many of the busiest threads to list")
        .default(10)
        .argParser(parseTopThreads)
    );

  registerJsonOption(summarizeCommand).action((paths: string[], options: { top: number }) => {
    const summaries: SummarizeOutput = readResults(paths).map(({ path, result }) => ({
      path,
      ...summarizeResult(result, { topThreads: options.top }),
    }));

    printResult(summaries, (values) =>
      console.log(
        values
          .map((summary) => `${formatResultSummary(summary)}\n  File: ${summary.path}`)
          .join("\n\n")
      )
    );
  });
};
