import React, { useMemo, useContext } from "react";
import { VideoEnabledContext } from "../../../videoCurrentTimeContext";
import { ApexOptions } from "apexcharts";
import { getColorPalette } from "../../theme/colors";
import { getLastX, useSetVideoTimeOnMouseHover } from "./useSetVideoTimeOnMouseHover";
import { AnnotationInterval, LineSeriesType } from "./types";
import { getAnnotations } from "./getAnnotations";
import { Chart } from "./Chart";
import { roundToDecimal } from "@lantern/reporter";

/** Points are positioned in milliseconds; the axis and the tooltip read in seconds. */
const formatSeconds = (value: string | number) => `${roundToDecimal(Number(value) / 1000, 1)} s`;

export const ReportChart = ({
  title,
  series,
  height,
  timeLimit,
  maxValue,
  showLegendForSingleSeries,
  colors = getColorPalette(),
  annotationIntervalList = undefined,
}: {
  title: string | React.ReactNode;
  series: LineSeriesType;
  height: number;
  timeLimit?: number | null;
  maxValue?: number;
  showLegendForSingleSeries?: boolean;
  colors?: string[];
  annotationIntervalList?: AnnotationInterval[];
}) => {
  const setVideoCurrentTimeOnMouseHover = useSetVideoTimeOnMouseHover({
    lastX: getLastX(series),
  });

  const videoEnabled = useContext(VideoEnabledContext);

  const options: ApexOptions = useMemo(
    () => ({
      chart: {
        events: videoEnabled ? setVideoCurrentTimeOnMouseHover : {},
      },
      annotations: getAnnotations(videoEnabled, annotationIntervalList) || {},
      stroke: {
        width: 2,
      },
      xaxis: {
        type: "numeric",
        max: timeLimit || undefined,
        labels: { formatter: formatSeconds },
      },
      tooltip: {
        x: { formatter: formatSeconds },
      },
      yaxis: {
        min: 0,
        max: maxValue,
      },
      legend: {
        showForSingleSeries: showLegendForSingleSeries,
      },
    }),
    [
      videoEnabled,
      setVideoCurrentTimeOnMouseHover,
      annotationIntervalList,
      timeLimit,
      maxValue,
      showLegendForSingleSeries,
    ]
  );

  return (
    <Chart
      type="line"
      title={title}
      series={series}
      colors={colors}
      height={height}
      options={options}
    />
  );
};
