import { installSignalHandlers, profiler } from "@lantern/profiler";
import { getAverageCpuUsage } from "@lantern/reporter";
import { Measure, ThreadNames } from "@lantern/types";

installSignalHandlers();

const bundleId = profiler.detectCurrentBundleId() || "";

const measures: Measure[] = [];

const session = profiler.startSession(bundleId);
session.on("measure", (measure: Measure) => {
  measures.push(measure);
  console.log(`JS Thread CPU Usage: ${measure.cpu.perName[ThreadNames.RN.JS_ANDROID]}%`);
  console.log(`RAM Usage: ${measure.ram}MB`);
});

setTimeout(async () => {
  await session.stop();
  const averageCpuUsage = getAverageCpuUsage(measures);
  console.log(`Average CPU Usage: ${averageCpuUsage}%`);
}, 10000);
