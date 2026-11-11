import { AveragedTestCaseResult } from "@lantern/types";
import { getMeasureOffsets, roundToDecimal } from "@lantern/reporter";

type OptionalStat = "ram" | "fps";

/**
 * Whether at least one measure of one result carries `stat`. A section is shown as soon as
 * there is something to draw: measures without the stat become gaps in the line (see
 * `buildValueGraph`) — iOS, for one, omits `fps` until its first graphics sample.
 */
export const hasValueForSomeMeasure = (results: AveragedTestCaseResult[], stat: OptionalStat) =>
  results.some((result) => result.average.measures.some((measure) => measure[stat] !== undefined));

/**
 * A measure without the stat becomes a `null` point, which ApexCharts renders as a gap in the
 * line. Dropping the point instead would make the chart interpolate straight across it.
 */
export const buildValueGraph = ({
  results,
  stat,
}: {
  results: AveragedTestCaseResult[];
  stat: OptionalStat;
}) =>
  results.map((result) => {
    const offsets = getMeasureOffsets(result.average.measures);

    return {
      name: result.name,
      data: result.average.measures.map((measure, i) => {
        const value = measure[stat];

        return {
          x: Math.round(offsets[i]),
          y: value === undefined ? null : roundToDecimal(value, 0),
        };
      }),
    };
  });
