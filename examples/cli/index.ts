import { installSignalHandlers, profiler } from "@lantern/profiler";
import { getAverageCpuUsage } from "@lantern/reporter";
import { Measure, ThreadNames } from "@lantern/types";

installSignalHandlers();

const main = async () => {
  const bundleId = await profiler.detectCurrentBundleId();

  const measures: Measure[] = [];

  const session = profiler.startSession(bundleId);
  session.on("measure", (measure: Measure) => {
    measures.push(measure);
    console.log(`JS Thread CPU Usage: ${measure.cpu.perName[ThreadNames.RN.JS_ANDROID]}%`);
    console.log(`RAM Usage: ${measure.ram}MB`);
  });

  await new Promise((resolve) => setTimeout(resolve, 10000));
  await session.stop();
  // Releases what the profiler keeps across sessions (the iOS `serve` process)
  profiler.dispose();
  const averageCpuUsage = getAverageCpuUsage(measures);
  console.log(`Average CPU Usage: ${averageCpuUsage}%`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
