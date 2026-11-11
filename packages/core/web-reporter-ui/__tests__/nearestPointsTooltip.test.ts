import { describe, it, expect } from "bun:test";
import {
  buildTooltipElement,
  getNearestPoints,
} from "../src/components/Charts/nearestPointsTooltip";
import { LineSeriesType } from "../src/components/Charts/types";

const series: LineSeriesType = [
  {
    name: "before",
    data: [
      { x: 0, y: 60 },
      { x: 503, y: 58 },
      { x: 1007, y: 41 },
      { x: 1510, y: 59 },
    ],
  },
  {
    name: "after",
    data: [
      { x: 0, y: 60 },
      { x: 498, y: 60 },
      { x: 1001, y: null },
      { x: 1499, y: 57 },
      { x: 2004, y: 60 },
      { x: 2502, y: 60 },
    ],
  },
];

describe("getNearestPoints", () => {
  it("reads every series at its point closest to the hovered one", () => {
    expect(getNearestPoints({ series, seriesIndex: 0, dataPointIndex: 1 })).toEqual({
      x: 503,
      points: [
        { seriesIndex: 0, name: "before", y: 58 },
        { seriesIndex: 1, name: "after", y: 60 },
      ],
    });
    expect(getNearestPoints({ series, seriesIndex: 1, dataPointIndex: 3 })).toEqual({
      x: 1499,
      points: [
        { seriesIndex: 0, name: "before", y: 59 },
        { seriesIndex: 1, name: "after", y: 57 },
      ],
    });
  });

  it("leaves out a series with a gap there", () => {
    expect(getNearestPoints({ series, seriesIndex: 0, dataPointIndex: 2 })?.points).toEqual([
      { seriesIndex: 0, name: "before", y: 41 },
    ]);
  });

  it("leaves out a series that ended more than a polling interval earlier", () => {
    expect(getNearestPoints({ series, seriesIndex: 1, dataPointIndex: 4 })?.points).toEqual([
      { seriesIndex: 0, name: "before", y: 59 },
      { seriesIndex: 1, name: "after", y: 60 },
    ]);
    expect(getNearestPoints({ series, seriesIndex: 1, dataPointIndex: 5 })?.points).toEqual([
      { seriesIndex: 1, name: "after", y: 60 },
    ]);
  });

  it("leaves out hidden and empty series", () => {
    expect(
      getNearestPoints({
        series: [...series, { name: "empty", data: [] }],
        seriesIndex: 0,
        dataPointIndex: 1,
        hiddenSeriesIndexes: [1],
      })?.points
    ).toEqual([{ seriesIndex: 0, name: "before", y: 58 }]);
  });

  it("is undefined for a point that does not exist", () => {
    expect(getNearestPoints({ series, seriesIndex: 0, dataPointIndex: 12 })).toBeUndefined();
    expect(getNearestPoints({ series, seriesIndex: 4, dataPointIndex: 0 })).toBeUndefined();
  });
});

describe("buildTooltipElement", () => {
  it("renders the time and one row per series", () => {
    const tooltip = buildTooltipElement({
      title: "0.5 s",
      rows: [
        { name: "before", value: "58", color: "#ff0000" },
        { name: "after", value: "60" },
      ],
    });

    expect(tooltip.querySelector(".apexcharts-tooltip-title")?.textContent).toBe("0.5 s");
    expect(
      Array.from(tooltip.querySelectorAll(".apexcharts-tooltip-series-group")).map(
        (row) => row.textContent
      )
    ).toEqual(["before: 58", "after: 60"]);
  });

  it("never interprets a series name as markup", () => {
    const tooltip = buildTooltipElement({
      title: "0 s",
      rows: [{ name: "<img src=x onerror=alert(1)>", value: "1" }],
    });

    expect(tooltip.querySelector("img")).toBeNull();
    expect(tooltip.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
