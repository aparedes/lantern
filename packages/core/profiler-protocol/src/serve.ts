/**
 * The request/response half of `lantern-ios-profiler serve` (see README.md): one request line
 * in, one `{"type":"response"}` line out, matched by `id`, interleaved with the stream lines of
 * a running poll.
 */

export interface ServeRequest {
  id: number;
  cmd: string;
  [param: string]: unknown;
}

export interface ServeResponseError {
  code: string;
  message: string;
}

export interface ServeResponse {
  type: "response";
  id: number;
  result?: unknown;
  error?: ServeResponseError;
}

/** A failed `serve` request; `code` is the binary's error code (`NO_DEVICE`, `BUSY`...). */
export class ServeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ServeRequestError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Narrows a parsed line to a reply (a `response` with a numeric `id`). */
export const isServeResponse = (line: unknown): line is ServeResponse =>
  isRecord(line) && line.type === "response" && typeof line.id === "number";

/** The error a failed reply carries, else undefined for a successful one. */
export const serveResponseError = (response: ServeResponse): ServeRequestError | undefined => {
  const error = response.error;
  if (!isRecord(error)) return undefined;

  return new ServeRequestError(
    typeof error.code === "string" ? error.code : "UNKNOWN",
    typeof error.message === "string" ? error.message : "unknown error"
  );
};

/** The request line to write to the binary's stdin (with its trailing newline). */
export const serializeServeRequest = (request: ServeRequest): string =>
  `${JSON.stringify(request)}\n`;
