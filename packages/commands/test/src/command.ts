import { Command, Option } from "commander";
import type { TestCase } from "./measurePerformance";
import { executeAsync } from "./executeAsync";
import {
  parseBitRate,
  parseDuration,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./commands/optionParsers";
import { PerformanceTester } from "./PerformanceTester";
import { Logger } from "@lantern/logger";
import {
  CommonOptions,
  applyCommonOptions,
  profiler,
  registerCommonOptions,
} from "@lantern/profiler";

export const registerTestCommand = (program: Command) => {
  const testCommand = program
    .command("test")
    .summary("Run a test several times and measure performance")
    .description(
      `Run a test several times and measure performance.

Main usage:
lantern test --bundleId <your app id> --testCommand <your test command>

Example with Maestro:
lantern test --bundleId com.example.app --testCommand "maestro test flow.yml"
`
    )
    .requiredOption(
      "--testCommand <testCommand>",
      "Test command (e.g. `maestro test flow.yml`). App performance during execution of this script will be measured over several iterations."
    )
    .requiredOption("--bundleId <bundleId>", "Bundle id of your app")
    .addOption(
      new Option(
        "--iterationCount <iterationCount>",
        "Amount of iterations to be run. Results will be averaged."
      )
        .default(10)
        .argParser(parsePositiveInteger)
    )
    .addOption(
      new Option(
        "--maxRetries <maxRetries>",
        "Maximum number of retries allowed over all iterations."
      )
        .default(3)
        .argParser(parseNonNegativeInteger)
    )
    .addOption(
      new Option(
        "--duration <duration>",
        "Duration (in ms) is optional, but helps in getting consistent measures. Measures will be taken for this duration, regardless of test duration"
      ).argParser(parseDuration)
    )
    .option(
      "--beforeEachCommand <beforeEachCommand>",
      "Command to be run before each test iteration"
    )
    .option("--afterEachCommand <afterEachCommand>", "Command to be run after each test iteration")
    .option("--beforeAllCommand <beforeAllCommand>", "Command to be run before all test iterations")
    .option("--resultsFilePath <resultsFilePath>", "Path where the JSON of results will be written")
    .option(
      "--resultsTitle <resultsTitle>",
      "Result title that is displayed at the top of the report"
    )
    .option(
      "--record",
      "Allows you to record a video of the test. This is useful for debugging purposes."
    )
    .addOption(
      new Option(
        "--recordBitRate <recordBitRate>",
        "Set the video bit rate, in bits per second.  Value may be specified as bits or megabits, e.g. '4000000' is equivalent to '4M'."
      ).argParser(parseBitRate)
    )
    .option(
      "--recordSize <recordSize>",
      'Set the video size, e.g. "1280x720".  Default is the device\'s main display resolution (if supported), 1280x720 if not.  For best results, use a size supported by the AVC encoder.'
    )
    .addOption(
      new Option(
        "--skipRestart",
        "By default, Lantern closes the app before each iteration. This is useful if your e2e test starts the app, if it doesn't, add this flag"
      ).default(false)
    );

  registerCommonOptions(testCommand).action(async (options) => {
    await runTest(options);
  });
};

const runTest = async ({
  duration,
  iterationCount,
  maxRetries,
  beforeEachCommand,
  beforeAllCommand,
  bundleId,
  testCommand,
  resultsFilePath,
  resultsTitle,
  afterEachCommand,
  record,
  recordSize,
  recordBitRate,
  skipRestart,
  ...commonOptions
}: CommonOptions & {
  duration?: number;
  iterationCount?: number;
  maxRetries?: number;
  beforeAllCommand?: string;
  beforeEachCommand?: string;
  afterEachCommand?: string;
  testCommand: string;
  bundleId: string;
  resultsFilePath?: string;
  resultsTitle?: string;
  record?: boolean;
  recordSize?: string;
  recordBitRate?: number;
  skipRestart?: boolean;
}) => {
  const { platform: resolvedPlatform } = await applyCommonOptions(commonOptions);

  if (record && !profiler.supportsScreenRecording()) {
    Logger.warn(
      `--record was passed but screen recording is not supported on ${resolvedPlatform}, no video will be recorded`
    );
  }
  if (beforeAllCommand) await executeAsync(beforeAllCommand);

  const testCase: TestCase = {
    beforeTest: async () => {
      if (!skipRestart) {
        await profiler.stopApp(bundleId);
      }

      if (beforeEachCommand) await executeAsync(beforeEachCommand);
    },
    run: async () => {
      await executeAsync(testCommand);
    },
    afterTest: async () => {
      if (afterEachCommand) await executeAsync(afterEachCommand);
    },
    duration,
  };

  const performanceTester = new PerformanceTester(bundleId, testCase, {
    iterationCount,
    maxRetries,
    recordOptions: {
      record: !!record,
      size: recordSize,
      bitRate: recordBitRate,
    },
    resultsFileOptions: {
      path: resultsFilePath,
      title: resultsTitle,
    },
  });

  try {
    await performanceTester.iterate();
    performanceTester.writeResults();
    // The iOS profiler keeps a `serve` process alive; release it so the CLI can exit
    profiler.dispose();
  } catch (error) {
    profiler.dispose();
    // Best effort: the report is a degraded view, its failure must not hide the test failure
    try {
      performanceTester.writeResults();
    } catch (writeError) {
      Logger.error(
        `Could not write the results file: ${
          writeError instanceof Error ? writeError.message : "unknown error"
        }`
      );
    }

    if (error instanceof Error) {
      Logger.error(`Lantern test FAILED ❌: ${error.message}
      You can still open a degraded view of the report`);
    }

    process.exit(1);
  }
};
