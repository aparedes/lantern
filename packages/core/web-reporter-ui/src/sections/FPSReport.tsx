import { useMemo } from "react";
import { AveragedTestCaseResult } from "@lantern/types";
import { buildValueGraph } from "./hideSectionForEmptyValue";
import { ReportChart } from "../components/Charts/ReportChart";
import { AnnotationInterval } from "../components/Charts/types";

/** The distinct refresh rates of the compared results, highest first; 60 for files that recorded none. */
const getTargetRates = (results: AveragedTestCaseResult[]) =>
  [...new Set(results.map((result) => result.specs?.refreshRate ?? 60))].sort((a, b) => b - a);

/**
 * One "safe zone" band per refresh rate: a result from a 60 Hz device is read against 60 FPS
 * even when it is compared with one from a 120 Hz device. The bands only name their rate when
 * there are several.
 */
export const getFpsSafeZones = (targetRates: number[]): AnnotationInterval[] =>
  targetRates.map((rate) => ({
    y: Math.round(rate * 0.95),
    y2: rate,
    color: "#158000",
    label: targetRates.length > 1 ? `Safe Zone (${rate} Hz)` : "Safe Zone",
  }));

export const FPSReport = ({ results }: { results: AveragedTestCaseResult[] }) => {
  // Keyed on the rates themselves: `results` is a new array on every render
  const targetRatesKey = getTargetRates(results).join(",");
  const annotationIntervalList = useMemo(
    () => getFpsSafeZones(targetRatesKey.split(",").map(Number)),
    [targetRatesKey]
  );
  const fps = buildValueGraph({
    results,
    stat: "fps",
  });

  return (
    <ReportChart
      title="Frame rate (FPS)"
      height={500}
      series={fps}
      annotationIntervalList={annotationIntervalList}
    />
  );
};
