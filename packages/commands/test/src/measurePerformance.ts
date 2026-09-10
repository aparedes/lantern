import { profiler } from "@lantern/profiler";
import { PerformanceTester, PerformanceTesterOptions } from "./PerformanceTester";
import { TestCase } from "./SingleIterationTester";

export type { TestCase };

export const measurePerformance = async (
  bundleId: string,
  testCase: TestCase,
  options?: PerformanceTesterOptions
) => {
  const tester = new PerformanceTester(bundleId, testCase, options);

  try {
    await tester.iterate();
  } finally {
    // The iOS profiler keeps a `serve` child alive for the whole session, which would hold an
    // embedding script open long after its measures are in — the CLI releases it the same way
    // once `iterate()` is over. A later call spawns a new one.
    profiler.dispose();
  }

  return {
    measures: tester.measures,
    writeResults: () => tester.writeResults(),
  };
};
