import { useMemo } from "react";
import { AveragedTestCaseResult } from "@lantern/types";
import { buildValueGraph } from "./hideSectionForEmptyValue";
import { ReportChart } from "../components/Charts/ReportChart";

/** The highest refresh rate among the compared results; 60 for files that recorded none. */
const getTargetFps = (results: AveragedTestCaseResult[]) =>
  Math.max(...results.map((result) => result.specs?.refreshRate ?? 60));

export const FPSReport = ({ results }: { results: AveragedTestCaseResult[] }) => {
  const targetFps = getTargetFps(results);
  const annotationIntervalList = useMemo(
    () => [
      { y: Math.round(targetFps * 0.95), y2: targetFps, color: "#158000", label: "Safe Zone" },
    ],
    [targetFps]
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
