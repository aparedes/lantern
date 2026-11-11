import React from "react";
import { AveragedTestCaseResult, Measure } from "@lantern/types";
import { ComparativeThreadTable, ThreadTable } from "../components/ThreadTable";
import { Collapsible } from "../components/Collapsible";
import { getColorPalette } from "../theme/colors";
import { getAverageCpuUsage, getMeasureOffsets, roundToDecimal } from "@lantern/reporter";
import { ReportChart } from "../components/Charts/ReportChart";
import { THREAD_ICON_MAPPING, getAutoSelectedThreads, getNumberOfThreads } from "./threads";

const buildSeriesData = (measures: Measure[], calculate: (measure: Measure) => number) => {
  const offsets = getMeasureOffsets(measures);

  return measures
    .map((measure) => calculate(measure) || 0)
    .map((value, i) => ({
      x: Math.round(offsets[i]),
      y: roundToDecimal(value, 1),
    }));
};

const buildAverageCpuSeriesData = (measures: Measure[]) =>
  buildSeriesData(measures, (measure) => getAverageCpuUsage([measure]));

const buildCpuPerThreadSeriesData = (measures: Measure[], threadName: string) =>
  buildSeriesData(measures, (measure) => measure.cpu.perName[threadName]);

const totalCpuAnnotationInterval = [{ y: 300, y2: 1000, color: "#E62E2E", label: "Danger Zone" }];

const perThreadCpuAnnotationInterval = [{ y: 90, y2: 100, color: "#E62E2E", label: "Danger Zone" }];

export const CPUReport = ({ results }: { results: AveragedTestCaseResult[] }) => {
  // Lazy initialiser: the auto-selection walks every result, and only the first render needs it.
  const [selectedThreads, setSelectedThreads] = React.useState<string[]>(() =>
    getAutoSelectedThreads(results)
  );

  const threads = selectedThreads
    .map((threadName) =>
      results.map((result) => ({
        name: `${threadName}${results.length > 1 ? ` (${result.name})` : ""}`,
        data: buildCpuPerThreadSeriesData(result.average.measures, threadName),
      }))
    )
    .flat();

  const totalCPUUsage = results.map((result) => ({
    name: result.name,
    data: buildAverageCpuSeriesData(result.average.measures),
  }));

  const TitleIcon = THREAD_ICON_MAPPING[selectedThreads[0]];

  const chartTitle =
    selectedThreads.length === 1 ? (
      <div className="flex flex-row align-center">
        {TitleIcon ? (
          <div className="mr-3 flex items-center">
            <TitleIcon size={30} />
          </div>
        ) : null}
        {`${selectedThreads[0]} CPU Usage (%)`}
      </div>
    ) : (
      "CPU Usage per thread (%)"
    );

  return (
    <>
      <ReportChart
        title="Total CPU Usage (%)"
        height={500}
        series={totalCPUUsage}
        annotationIntervalList={totalCpuAnnotationInterval}
      />
      {getNumberOfThreads(results) > 1 && (
        <>
          <ReportChart
            title={chartTitle}
            height={500}
            series={threads}
            colors={results.length > 1 ? getColorPalette().slice(0, results.length) : undefined}
            maxValue={100}
            showLegendForSingleSeries
            annotationIntervalList={perThreadCpuAnnotationInterval}
          />
          <Collapsible
            unmountOnExit
            header={<div className="text-neutral-200 text-xl">{"Other threads"}</div>}
            className="border rounded-lg border-gray-800 py-4 px-4"
          >
            {results.length > 1 ? (
              <ComparativeThreadTable
                results={results}
                selectedThreads={selectedThreads}
                setSelectedThreads={setSelectedThreads}
              />
            ) : (
              <ThreadTable
                measures={results[0].average.measures}
                selectedThreads={selectedThreads}
                setSelectedThreads={setSelectedThreads}
              />
            )}
          </Collapsible>
        </>
      )}
    </>
  );
};
