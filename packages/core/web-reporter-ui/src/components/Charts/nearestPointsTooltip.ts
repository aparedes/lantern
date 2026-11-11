import { POLLING_INTERVAL } from "@lantern/types";
import { LineDataPointType, LineSeriesType } from "./types";

/** Index of the point of `data` (sorted by x) closest to `x`. `data` must not be empty. */
const findNearestIndex = (data: LineDataPointType[], x: number) => {
  let low = 0;
  let high = data.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(data[middle].x) < x) low = middle + 1;
    else high = middle;
  }
  // `low` is the first point at or after `x`: the one before it may still be closer
  if (low > 0 && x - Number(data[low - 1].x) <= Number(data[low].x) - x) return low - 1;

  return low;
};

export interface NearestPoints {
  /** x of the hovered point. */
  x: number;
  points: { seriesIndex: number; name: string; y: number }[];
}

/**
 * What each series reads around the hovered point: its own point closest in time. ApexCharts
 * only groups series in one tooltip when their points share the very same x, which compared
 * results never do — each one was sampled at its own times. A series with nothing within one
 * polling interval (it ended earlier, or has a gap there) is left out, as are hidden ones.
 */
export const getNearestPoints = ({
  series,
  seriesIndex,
  dataPointIndex,
  hiddenSeriesIndexes = [],
}: {
  series: LineSeriesType;
  seriesIndex: number;
  dataPointIndex: number;
  hiddenSeriesIndexes?: number[];
}): NearestPoints | undefined => {
  const hovered = series[seriesIndex]?.data[dataPointIndex];
  if (!hovered) return undefined;
  const x = Number(hovered.x);

  const points = series.flatMap(({ name, data }, i) => {
    if (data.length === 0 || hiddenSeriesIndexes.includes(i)) return [];

    const nearest = data[findNearestIndex(data, x)];
    if (nearest.y === null || Math.abs(Number(nearest.x) - x) > POLLING_INTERVAL) return [];

    return [{ seriesIndex: i, name, y: nearest.y }];
  });

  return { x, points };
};

const element = (tagName: string, className: string, text?: string) => {
  const node = document.createElement(tagName);
  node.className = className;
  // `textContent`, never `innerHTML`: series are named after result files
  if (text !== undefined) node.textContent = text;

  return node;
};

/** The tooltip body, in the markup (and so the look) of the ApexCharts default one. */
export const buildTooltipElement = ({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; value: string; color?: string }[];
}): HTMLElement => {
  const tooltip = element("div", "");
  tooltip.appendChild(element("div", "apexcharts-tooltip-title", title));

  for (const { name, value, color } of rows) {
    const row = element("div", "apexcharts-tooltip-series-group apexcharts-active");
    row.style.display = "flex";

    const marker = element("span", "apexcharts-tooltip-marker");
    marker.style.borderRadius = "50%";
    if (color) marker.style.backgroundColor = color;
    row.appendChild(marker);

    const text = element("div", "apexcharts-tooltip-text");
    const group = element("div", "apexcharts-tooltip-y-group");
    group.appendChild(element("span", "apexcharts-tooltip-text-y-label", `${name}: `));
    group.appendChild(element("span", "apexcharts-tooltip-text-y-value", value));
    text.appendChild(group);
    row.appendChild(text);

    tooltip.appendChild(row);
  }

  return tooltip;
};
