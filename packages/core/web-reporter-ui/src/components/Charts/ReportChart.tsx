import React, { useMemo, useContext, useEffect, useRef } from "react";
import { VideoEnabledContext } from "../../../videoCurrentTimeContext";
import { ApexOptions, type ApexTooltipCustomOpts } from "apexcharts";
import { getColorPalette } from "../../theme/colors";
import { getLastX, useSetVideoTimeOnMouseHover } from "./useSetVideoTimeOnMouseHover";
import { AnnotationInterval, LineSeriesType } from "./types";
import { getAnnotations } from "./getAnnotations";
import { Chart } from "./Chart";
import { roundToDecimal } from "@lantern/reporter";
import { buildTooltipElement, getNearestPoints } from "./nearestPointsTooltip";

/** Points are positioned in milliseconds; the axis and the tooltip read in seconds. */
const formatSeconds = (value: string | number) => `${roundToDecimal(Number(value) / 1000, 1)} s`;

/**
 * The render state the tooltip below reads off the chart `tooltip.custom` is handed: the
 * resolved series colors and the series hidden from the legend. Not part of the public typings.
 */
type TooltipInternals = { globals: { colors?: string[]; collapsedSeriesIndices?: number[] } };

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

  // Read through a ref, like `lastX` in `useSetVideoTimeOnMouseHover`: the tooltip function
  // must not change with every new point, or apexcharts would be re-configured each time.
  const seriesRef = useRef(series);
  useEffect(() => {
    seriesRef.current = series;
  }, [series]);

  /** Every series around the hovered time, see `getNearestPoints`. */
  const nearestPointsTooltip = useMemo(
    () =>
      ({ seriesIndex, dataPointIndex, w }: ApexTooltipCustomOpts) => {
        const { globals } = w as unknown as TooltipInternals;
        const nearest = getNearestPoints({
          series: seriesRef.current,
          seriesIndex,
          dataPointIndex,
          hiddenSeriesIndexes: globals.collapsedSeriesIndices,
        });

        return buildTooltipElement({
          title: nearest ? formatSeconds(nearest.x) : "",
          rows: (nearest?.points ?? []).map((point) => ({
            name: point.name,
            value: `${point.y}`,
            color: globals.colors?.[point.seriesIndex],
          })),
        });
      },
    []
  );
  // A single series needs no grouping: the default tooltip already shows it
  const hasSeveralSeries = series.length > 1;

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
        ...(hasSeveralSeries ? { custom: nearestPointsTooltip } : {}),
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
      hasSeveralSeries,
      nearestPointsTooltip,
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
