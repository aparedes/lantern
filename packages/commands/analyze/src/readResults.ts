import fs from "fs";
import path from "path";
import { LanternError } from "@lantern/profiler-protocol";
import { TestCaseResult } from "@lantern/types";

export interface ResultsFile {
  path: string;
  result: TestCaseResult;
}

/** The results files `paths` name: files as given, folders expanded to the `.json` files they hold. */
export const resolveResultsPaths = (paths: string[]): string[] => {
  const missingPaths = paths.filter((resultsPath) => !fs.existsSync(resultsPath));
  if (missingPaths.length > 0) {
    throw new LanternError(
      "INVALID_ARGUMENT",
      `No such file or folder: ${missingPaths.join(", ")}`,
      {
        details: { missingPaths },
      }
    );
  }

  return paths.flatMap((resultsPath) =>
    // statSync follows symlinks, so a symlinked results folder works too
    fs.statSync(resultsPath).isDirectory()
      ? fs
          .readdirSync(resultsPath)
          .filter((file) => file.endsWith(".json"))
          .map((file) => path.join(resultsPath, file))
      : [resultsPath]
  );
};

const isResult = (value: unknown): value is TestCaseResult =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as TestCaseResult).name === "string" &&
  Array.isArray((value as TestCaseResult).iterations);

/**
 * Reads and checks the results files `paths` name (see `resolveResultsPaths`). A missing path, or
 * a file that is not a lantern results file, rejects with `INVALID_ARGUMENT`.
 */
export const readResults = (paths: string[]): ResultsFile[] =>
  resolveResultsPaths(paths).map((resultsPath) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    } catch (error) {
      throw new LanternError(
        "INVALID_ARGUMENT",
        `${resultsPath} is not valid JSON: ${error instanceof Error ? error.message : error}`,
        { details: { path: resultsPath }, cause: error }
      );
    }

    if (!isResult(parsed)) {
      throw new LanternError(
        "INVALID_ARGUMENT",
        `${resultsPath} is not a lantern results file (expected a "name" and "iterations")`,
        { details: { path: resultsPath } }
      );
    }

    return { path: resultsPath, result: parsed };
  });
