/** The defined entries of `values`, in order. */
export const definedValues = (values: (number | undefined)[]): number[] =>
  values.filter((value): value is number => value !== undefined);

const extremeOf = (
  values: (number | undefined)[],
  isMoreExtreme: (value: number, current: number) => boolean
) => {
  let extreme: number | undefined;
  for (const value of values) {
    if (value !== undefined && (extreme === undefined || isMoreExtreme(value, extreme))) {
      extreme = value;
    }
  }

  return extreme;
};

// Loops rather than `Math.min(...values)`: a long live session holds more samples than an
// engine accepts as arguments.

/** The smallest defined value, or undefined when there is none. */
export const minOf = (values: (number | undefined)[]) =>
  extremeOf(values, (value, current) => value < current);

/** The largest defined value, or undefined when there is none. */
export const maxOf = (values: (number | undefined)[]) =>
  extremeOf(values, (value, current) => value > current);
