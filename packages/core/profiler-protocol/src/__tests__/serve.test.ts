import { describe, expect, it } from "bun:test";
import { parseProfilerLine } from "../index";
import {
  ServeRequestError,
  isServeResponse,
  serializeServeRequest,
  serveResponseError,
} from "../serve";

describe("isServeResponse", () => {
  it("accepts response lines with a numeric id", () => {
    expect(isServeResponse(parseProfilerLine('{"type":"response","id":3,"result":{}}'))).toBe(true);
  });

  it("rejects stream lines and malformed responses", () => {
    expect(isServeResponse(parseProfilerLine('{"type":"measure","time":1}'))).toBe(false);
    expect(isServeResponse(parseProfilerLine('{"type":"response","id":"3"}'))).toBe(false);
    expect(isServeResponse(undefined)).toBe(false);
    expect(isServeResponse(null)).toBe(false);
  });
});

describe("serveResponseError", () => {
  it("is undefined for a successful reply", () => {
    expect(serveResponseError({ type: "response", id: 1, result: [] })).toBeUndefined();
  });

  it("carries the binary's code and message", () => {
    const error = serveResponseError({
      type: "response",
      id: 1,
      error: { code: "BUSY", message: "a poll is running: send stop first" },
    });

    expect(error).toBeInstanceOf(ServeRequestError);
    expect(error?.code).toBe("BUSY");
    expect(error?.message).toBe("a poll is running: send stop first");
  });

  it("falls back to placeholders when the error object is incomplete", () => {
    const error = serveResponseError({
      type: "response",
      id: 1,
      error: {} as { code: string; message: string },
    });

    expect(error?.code).toBe("UNKNOWN");
    expect(error?.message).toBe("unknown error");
  });
});

describe("serializeServeRequest", () => {
  it("writes one JSON line", () => {
    expect(serializeServeRequest({ id: 2, cmd: "poll", bundleId: "com.example" })).toBe(
      '{"id":2,"cmd":"poll","bundleId":"com.example"}\n'
    );
  });
});
