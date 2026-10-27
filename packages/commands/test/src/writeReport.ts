import { Logger } from "@lantern/logger";
import { averageTestCaseResult } from "@lantern/reporter";
import {
  AveragedTestCaseResult,
  TestCaseIterationResult,
  TestCaseResult,
  TestCaseResultStatus,
} from "@lantern/types";
import fs from "fs";
import path from "path";

/**
 * A test case fails as soon as any of its iterations failed, wherever it sits in the list.
 * Retried iterations are ignored: their measures are discarded by design and the iteration was run
 * again (see `PerformanceTester`).
 */
export const getTestCaseStatus = (iterations: TestCaseIterationResult[]): TestCaseResultStatus => {
  if (iterations.length === 0) return "FAILURE";

  return iterations.some(
    (iteration) => iteration.status === "FAILURE" && !iteration.isRetriedIteration
  )
    ? "FAILURE"
    : "SUCCESS";
};

/** What is known about the run's device, written next to the iterations. */
export type ResultMetadata = Pick<TestCaseResult, "platform" | "device" | "specs">;

/** Writes the results file and returns the result it contains. */
export const writeReport = (
  measures: TestCaseIterationResult[],
  {
    filePath,
    title,
    overrideScore,
    metadata = {},
  }: {
    filePath: string;
    title: string;
    overrideScore?: (result: AveragedTestCaseResult) => number;
    metadata?: ResultMetadata;
  }
): TestCaseResult => {
  const testCase: TestCaseResult = {
    name: title,
    ...metadata,
    iterations: measures,
    status: getTestCaseStatus(measures),
  };

  /**
   * Might not be the best place to put this since this is reporting
   * and not really measuring
   */
  if (overrideScore) {
    const averagedResult: AveragedTestCaseResult = averageTestCaseResult(testCase);
    testCase.score = Math.max(0, Math.min(overrideScore(averagedResult), 100));
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(testCase));

  Logger.success(
    `Results written to ${filePath}.
To open the web report, run:

lantern report ${filePath}`
  );

  return testCase;
};
