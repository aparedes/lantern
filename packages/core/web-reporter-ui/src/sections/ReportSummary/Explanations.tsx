// es-toolkit's main-entry `orderBy` requires `T extends object`, but here we sort an
// array of `string` (thread names) by a derived value, so use the compat build whose
// signature (lodash-compatible: single iteratee/order, no array wrapping needed) covers it.
import { orderBy } from "es-toolkit/compat";
import { roundToDecimal, sanitizeProcessName } from "@lantern/reporter";
import { AveragedTestCaseResult } from "@lantern/types";

const AverageTestRuntimeExplanation = () => (
  <>
    Time taken to run the test.
    <br />
    Can be helpful to measure Time To Interactive of your app, if the test is checking app start for
    instance.
  </>
);

const AverageFPSExplanation = ({ refreshRate }: { refreshRate: number }) => (
  <>
    {`Frame Per Second. Your app should display ${refreshRate} Frames Per Second to give an impression of fluidity. This number should be close to ${refreshRate}, otherwise it will seem laggy.`}{" "}
    <br />
    On Android, time during which the app draws nothing counts as on target, so a static screen
    reads the refresh rate. On iOS, samples taken while nothing is rendered carry no FPS value and
    are left out of the average.
    <br />
    See{" "}
    <a href="https://www.youtube.com/watch?v=CaMTIgxCSqU" target="_blank" rel="noreferrer">
      this video
    </a>{" "}
    for more details
  </>
);

const LowestFPSExplanation = () => (
  <>
    The lowest FPS sample of the run: the worst half second. With several iterations, the average of
    each iteration&apos;s lowest sample.
  </>
);

const AverageCPUUsageExplanation = () => (
  <>
    An app might run at high frame rates, such as 60 FPS or higher, but might be using too much
    processing power, so it&apos;s important to check CPU usage.
    <br /> Depending on the device, this value can go up to <code>100% × number of cores</code>{" "}
    (400% on a 4-core device). On iOS the profiler reports the whole process, so it is not broken
    down per thread.
  </>
);

const AverageRAMUsageExplanation = () => (
  <>
    If an app consumes a large amount of RAM (random-access memory), it can impact the overall
    performance of the device and drain the battery more quickly.
    <br />
    It's worth noting that results might be higher than expected: on Android we measure RSS (not
    PSS), so memory shared with other processes is counted in full. On iOS the value is the
    process's physical footprint, as reported by the system monitor.
  </>
);

const PeakRAMUsageExplanation = () => (
  <>
    The highest RAM sample of the run. An average hides a memory that keeps growing; the peak is
    what the system sees when it decides whether to kill the app. With several iterations, the
    average of each iteration&apos;s peak.
  </>
);

const HighCPUUsageExplanation = ({
  result,
  refreshRate,
}: {
  result: AveragedTestCaseResult;
  refreshRate: number;
}) => (
  <>
    <div className="mb-2">
      <p>Impacted threads:</p>
      {orderBy(
        Object.keys(result.averageHighCpuUsage),
        (processName) => result.averageHighCpuUsage[processName],
        "desc"
      ).map((processName) => (
        <p key={processName} className="whitespace-pre">
          - {sanitizeProcessName(processName)} for{" "}
          {roundToDecimal(result.averageHighCpuUsage[processName] / 1000, 1)}s
        </p>
      ))}
    </div>
    {`High CPU usage by a single process can cause app unresponsiveness, even with low overall CPU usage. For instance, an overworked JS thread in a React Native app may lead to unresponsiveness despite maintaining ${refreshRate} FPS.`}
  </>
);

export const Explanations = {
  AverageTestRuntimeExplanation,
  AverageFPSExplanation,
  LowestFPSExplanation,
  AverageCPUUsageExplanation,
  AverageRAMUsageExplanation,
  PeakRAMUsageExplanation,
  HighCPUUsageExplanation,
};
