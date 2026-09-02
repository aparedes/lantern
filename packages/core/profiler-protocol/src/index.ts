/**
 * The wire protocol both profiler binaries speak, see README.md: NDJSON lines on stdout, and
 * `LANTERN_PROFILER_ERROR_*` / `LANTERN_PROFILER_WARN_*` markers on stderr.
 */

/** A lifecycle event. `event` values are platform specific (see README.md). */
export interface StatusLine {
  type: "status";
  event: string;
  pid?: number;
  name?: string;
  detail?: string;
}

/** Every line carries a string `type`; each platform narrows its own measure payload. */
export interface TypedLine {
  type: string;
}

export type ProfilerLine<TMeasure extends TypedLine = TypedLine> = StatusLine | TMeasure;

/** How long one Android sample took, split by section. */
export interface AndroidMeasureTimings {
  totalMs: number;
  cpuMs: number;
  ramMs: number;
  atraceMs: number;
}

/**
 * One raw Android sample: `/proc` snapshots passed through verbatim, the CPU / RAM / FPS maths
 * happen on the TypeScript side.
 */
export interface AndroidRawMeasureLine {
  type: "measure";
  /** The app's main pid, as printed by the device. */
  pid: string;
  /** `/proc/<pid>/task/*\/stat` lines, one per thread. */
  cpu: string;
  /** `/proc/<pid>/statm` lines, one per pid. */
  ram: string;
  /** atrace `trace_pipe` lines gathered since the previous sample, empty when idle or unavailable. */
  atrace: string;
  /** Epoch milliseconds. */
  timestamp: number;
  timings: AndroidMeasureTimings;
}

/**
 * One stdout line → its object, or undefined when it is not NDJSON with a string `type` (stray
 * output, or a JSON value that is not one of the binaries' line objects).
 */
export const parseProfilerLine = <TMeasure extends TypedLine = TypedLine>(
  rawLine: string
): ProfilerLine<TMeasure> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return undefined;
  }

  const type = (parsed as { type?: unknown } | null)?.type;

  return typeof type === "string" ? (parsed as ProfilerLine<TMeasure>) : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTimings = (value: unknown): value is AndroidMeasureTimings =>
  isRecord(value) &&
  (["totalMs", "cpuMs", "ramMs", "atraceMs"] as const).every(
    (key) => typeof value[key] === "number"
  );

/** Field-by-field check, so a truncated or foreign `measure` line is skipped rather than crashing the parsers. */
export const isAndroidRawMeasureLine = (line: unknown): line is AndroidRawMeasureLine =>
  isRecord(line) &&
  line.type === "measure" &&
  typeof line.pid === "string" &&
  typeof line.cpu === "string" &&
  typeof line.ram === "string" &&
  typeof line.atrace === "string" &&
  typeof line.timestamp === "number" &&
  isTimings(line.timings);

export const ERROR_MARKER = "LANTERN_PROFILER_ERROR_";
/** Non-fatal notices (e.g. a fallback was taken); never a command's failure cause. */
export const WARN_MARKER = "LANTERN_PROFILER_WARN_";

export interface MarkerLine {
  level: "error" | "warn";
  code: string;
  message: string;
}

const MARKER_PATTERN = /^LANTERN_PROFILER_(ERROR|WARN)_(\w+):\s*(.*)$/s;

/** `LANTERN_PROFILER_<ERROR|WARN>_<CODE>: message` → its parts, else undefined. */
export const parseMarkerLine = (line: string): MarkerLine | undefined => {
  const match = MARKER_PATTERN.exec(line);
  if (!match) return undefined;

  const [, level, code, message] = match;

  return { level: level === "ERROR" ? "error" : "warn", code, message };
};

/**
 * Human message of the LAST error marker in a stderr capture, else undefined. The last marker is
 * the one that ended the command; earlier ones (and warn markers, which are ignored here) are
 * context that must not mask it.
 */
export const lastErrorMessage = (stderr: string): string | undefined =>
  stderr
    .split("\n")
    .map(parseMarkerLine)
    .filter((marker) => marker?.level === "error")
    .at(-1)?.message;

export { ProfilingSessionBase } from "./session";
export {
  disposeAllSessions,
  installSignalHandlers,
  liveSessionCount,
  trackSession,
  untrackSession,
} from "./registry";
export type { SignalTarget } from "./registry";
export { describeExit, KILL_AFTER_MS, terminateChild } from "./child";
