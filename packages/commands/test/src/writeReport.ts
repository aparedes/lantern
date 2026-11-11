import { Logger } from "@lantern/logger";
import { averageTestCaseResult } from "@lantern/reporter";
import {
  AveragedTestCaseResult,
  DeviceSpecs,
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

export const writeReport = (
  measures: TestCaseIterationResult[],
  {
    filePath,
    title,
    overrideScore,
    specs,
  }: {
    filePath: string;
    title: string;
    specs?: DeviceSpecs;
    overrideScore?: (result: AveragedTestCaseResult) => number;
  }
) => {
  const testCase: TestCaseResult = {
    name: title,
    iterations: measures,
    status: getTestCaseStatus(measures),
    ...(specs ? { specs } : {}),
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
};
