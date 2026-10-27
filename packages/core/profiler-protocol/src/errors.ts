import { ServeRequestError } from "./serve";

/**
 * What went wrong, for scripts and agents: printed in the `--json` error envelope and mapped to
 * the process exit code (see `exitCodeFor`). The message stays the human-readable explanation.
 */
export const ERROR_CODES = [
  /** No device of the selected platform (or of any platform) is connected. */
  "NO_DEVICE",
  /** Devices of both platforms are connected and none was picked. */
  "AMBIGUOUS_PLATFORM",
  /** Several devices of the selected platform are connected and none was picked. */
  "AMBIGUOUS_DEVICE",
  /** The requested `--device` is not connected. */
  "UNKNOWN_DEVICE",
  /** The device is connected but cannot be profiled (Android API level, ABI...). */
  "UNSUPPORTED_DEVICE",
  /** A profiler binary Lantern needs is missing from this install. */
  "MISSING_BINARY",
  /** No app is in the foreground, so no bundle id could be detected. */
  "NO_FOREGROUND_APP",
  /** Several apps are running, so no bundle id could be detected. */
  "AMBIGUOUS_APP",
  /** The app is not installed on the device. */
  "APP_NOT_FOUND",
  /** The profiler did not report a first measure in time (is the app running?). */
  "PROFILER_START_TIMEOUT",
  /** The profiler exited before it started measuring. */
  "PROFILER_EXITED",
  /** Too few (or no) measures were received: the app likely crashed or never started. */
  "NO_MEASURES",
  /** A user-provided command (`--testCommand`, `--beforeEachCommand`...) failed. */
  "TEST_COMMAND_FAILED",
  /** Bad command-line usage or input file. */
  "INVALID_ARGUMENT",
  /** The run worked but a requested threshold (`--minScore`...) was not met. */
  "THRESHOLD_FAILED",
  /** Anything else. */
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface LanternErrorOptions {
  /** Structured context for the `--json` envelope (paths, counts, platform-side codes...). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** An error whose `code` tells scripts and agents what went wrong. */
export class LanternError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: ErrorCode,
    message: string,
    { details, cause }: LanternErrorOptions = {}
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LanternError";
    this.details = details;
  }
}

/** `serve` error codes of the iOS profiler binary that have a Lantern equivalent. */
const SERVE_CODES: Partial<Record<string, ErrorCode>> = {
  NO_DEVICE: "NO_DEVICE",
  APP_NOT_FOUND: "APP_NOT_FOUND",
};

/**
 * Any thrown value → a `LanternError`, keeping its message. A `LanternError` is returned as is,
 * an iOS `serve` failure keeps the binary's code in `details.platformCode`, anything else is
 * `INTERNAL`.
 */
export const toLanternError = (error: unknown): LanternError => {
  if (error instanceof LanternError) return error;

  if (error instanceof ServeRequestError) {
    return new LanternError(SERVE_CODES[error.code] ?? "INTERNAL", error.message, {
      details: { platformCode: error.code },
      cause: error,
    });
  }

  return new LanternError("INTERNAL", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
};

const SETUP_CODES: ReadonlySet<ErrorCode> = new Set([
  "NO_DEVICE",
  "AMBIGUOUS_PLATFORM",
  "AMBIGUOUS_DEVICE",
  "UNKNOWN_DEVICE",
  "UNSUPPORTED_DEVICE",
  "MISSING_BINARY",
  "NO_FOREGROUND_APP",
  "AMBIGUOUS_APP",
  "APP_NOT_FOUND",
]);

/**
 * `2` bad usage, `3` device or app setup problem, `4` threshold not met, `1` anything else
 * (a failed run included). Signals keep their own codes (130, 131, 143, see `registry.ts`).
 */
export const exitCodeFor = (code: ErrorCode): number => {
  if (code === "INVALID_ARGUMENT") return 2;
  if (code === "THRESHOLD_FAILED") return 4;
  if (SETUP_CODES.has(code)) return 3;

  return 1;
};
