import { Logger } from "@lantern/logger";
import { TestCaseIterationResult } from "@lantern/types";
import { getPlatform, profiler } from "@lantern/profiler";
import { LanternError, toLanternError } from "@lantern/profiler-protocol";
import * as p from "path";
import { Options, SingleIterationTester, TestCase } from "./SingleIterationTester";
import { ResultMetadata, writeReport } from "./writeReport";

export type PerformanceTesterOptions = Omit<
  Options,
  "resultsFileOptions" | "iterationCount" | "recordOptions" | "maxRetries"
> & {
  recordOptions?: Options["recordOptions"];
  maxRetries?: Options["maxRetries"];
  iterationCount?: Options["iterationCount"];
  resultsFileOptions?: {
    path?: string;
    title?: string;
  };
};

/**
 * The platform, device and refresh rate of the run. Best effort: the score falls back to 60 Hz
 * without a refresh rate, which is no reason to fail the run.
 */
const collectMetadata = async (): Promise<ResultMetadata> => {
  const metadata: ResultMetadata = { platform: getPlatform() };

  try {
    const { id, name, model } = await profiler.resolveDevice();
    metadata.device = model === undefined ? { id, name } : { id, name, model };
  } catch (error) {
    Logger.debug(`Could not resolve the device: ${error instanceof Error ? error.message : error}`);
  }

  try {
    metadata.specs = { refreshRate: await profiler.detectDeviceRefreshRate() };
  } catch (error) {
    Logger.warn(
      `Could not detect the refresh rate, FPS will be scored against 60 Hz: ${
        error instanceof Error ? error.message : error
      }`
    );
  }

  return metadata;
};

export class PerformanceTester {
  public measures: TestCaseIterationResult[] = [];
  /** Filled by `iterate()`, written to the results file next to the iterations. */
  public metadata: ResultMetadata = {};
  private retryCount = 0;
  options: Options;

  constructor(
    private bundleId: string,
    private testCase: TestCase,
    options: PerformanceTesterOptions = {}
  ) {
    const title = options.resultsFileOptions?.title || "Results";

    const path = options.resultsFileOptions?.path;
    const filePath = path ? p.join(process.cwd(), p.dirname(path)) : `${process.cwd()}`;
    const fileName = path
      ? p.basename(path)
      : `${title.toLocaleLowerCase().replace(/ /g, "_")}_${new Date().getTime()}`;

    this.options = {
      ...options,
      iterationCount: options.iterationCount ?? 10,
      maxRetries: options.maxRetries || 0,
      recordOptions: options.recordOptions || {
        record: false,
      },
      resultsFileOptions: {
        path: path || `${filePath}/${fileName}.json`,
        title,
      },
    };
  }

  async iterate(): Promise<void> {
    // Important to ensure that the profiler is installed before we run the test!
    await profiler.installProfilerOnDevice();
    this.metadata = await collectMetadata();

    let currentIterationIndex = 0;
    this.measures = [];

    while (currentIterationIndex < this.options.iterationCount) {
      const singleIterationTester = new SingleIterationTester(
        this.bundleId,
        this.testCase,
        this.options,
        currentIterationIndex
      );

      this.logIterationStart(currentIterationIndex);
      try {
        await singleIterationTester.executeTestCase();
        this.logSuccessfulIteration(
          currentIterationIndex,
          singleIterationTester.getCurrentTestCaseIterationResult()?.time
        );
        currentIterationIndex++;
      } catch (error) {
        this.logFailedIteration(currentIterationIndex, error);
        this.checkRetryIsPossible(singleIterationTester, error);
      } finally {
        const currentTestCaseIterationResult =
          singleIterationTester.getCurrentTestCaseIterationResult();
        if (currentTestCaseIterationResult) {
          this.measures.push(currentTestCaseIterationResult);
        }
      }
    }

    if (this.measures.length === 0) {
      throw new Error("No measure returned");
    }
  }

  writeResults() {
    const { path, title } = this.options.resultsFileOptions;
    return writeReport(this.measures, {
      filePath: path,
      title,
      overrideScore: this.testCase.getScore,
      metadata: this.metadata,
    });
  }

  /**
   * Throws once the retries are exhausted. The error keeps the failed iteration's code and
   * cause, so that "max retries" never hides why the iterations failed.
   */
  private checkRetryIsPossible(singleIterationTester: SingleIterationTester, error: unknown) {
    this.retryCount++;
    if (this.retryCount > this.options.maxRetries) {
      const cause = toLanternError(error);
      throw new LanternError(
        cause.code,
        `Max number of retries reached. Last failure: ${cause.message}`,
        {
          details: {
            ...cause.details,
            retries: this.options.maxRetries,
            failedIterations: this.retryCount,
          },
          cause,
        }
      );
    }
    singleIterationTester.setIsRetry(true);
    Logger.error(
      `Ignoring measure and retrying... (retry ${this.retryCount}/${this.options.maxRetries})`
    );
  }

  private logIterationStart(currentIterationIndex: number) {
    Logger.info(`Running iteration ${currentIterationIndex + 1}/${this.options.iterationCount}`);
  }

  private logFailedIteration(currentIterationIndex: number, error: unknown) {
    Logger.error(
      `Iteration ${currentIterationIndex + 1}/${this.options.iterationCount} failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  private logSuccessfulIteration(currentIterationIndex: number, time: number | undefined) {
    Logger.success(
      `Finished iteration ${currentIterationIndex + 1}/${this.options.iterationCount} in ${
        time ?? "unknown"
      }ms (${this.retryCount} ${this.retryCount > 1 ? "retries" : "retry"} so far)`
    );
  }
}
