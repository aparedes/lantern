import { describe, it, expect } from "bun:test";
import { FrameTimeParser, parseLine } from "../pollFpsUsage";

describe("parseLine", () => {
  it("parses atrace line", () => {
    expect(
      parseLine(
        "<...>-14862 (-----) [001] ...1  5199.769518: tracing_mark_write: B|14862|Choreographer#doFrame"
      )
    ).toEqual({
      ending: false,
      methodName: "|14862|Choreographer#doFrame",
      timestamp: 5199769.518,
    });

    expect(
      parseLine("<...>-14862 (-----) [001] ...1  5199.779518: tracing_mark_write: E|14862")
    ).toEqual({ ending: true, methodName: "|14862", timestamp: 5199779.518 });
  });
});

const SAMPLE_ATRACES = [
  `com.example-4808  (-----) [006] .... 176340.044726: tracing_mark_write: B|4808|Choreographer#doFrame 4573947
com.example-4808  (-----) [006] .... 176340.044756: tracing_mark_write: B|4808|animation
com.example-4808  (-----) [006] .... 176340.064412: tracing_mark_write: B|4808|Choreographer#scheduleVsyncLocked
com.example-4808  (-----) [006] .... 176340.064484: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.064853: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.064866: tracing_mark_write: B|4808|traversal
com.example-4808  (-----) [006] .... 176340.064914: tracing_mark_write: B|4808|draw
com.example-4808  (-----) [006] .... 176340.064942: tracing_mark_write: B|4808|Record View#draw()
com.example-4808  (-----) [006] .... 176340.065726: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.067496: tracing_mark_write: E|4808
com.example-4808  (-----) [005] ..s.  1799.488062: run_rebalance_domains: CPU5 FAILED TO GET (this is one line coming from Samsung A40)
com.example-4808  (-----) [006] .... 176340.067503: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.067509: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.147257: tracing_mark_write: B|4808|Choreographer#onVsync 4573951
com.example-4808  (-----) [006] .... 176340.147294: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.147355: tracing_mark_write: B|4808|Choreographer#doFrame 4573951
com.example-4808  (-----) [006] .... 176340.147372: tracing_mark_write: B|4808|animation
com.example-4808  (-----) [006] .... 176340.159522: tracing_mark_write: B|4808|Choreographer#scheduleVsyncLocked
com.example-4808  (-----) [006] .... 176340.159609: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.160177: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.160186: tracing_mark_write: B|4808|traversal
com.example-4808  (-----) [006] .... 176340.160244: tracing_mark_write: B|4808|draw
com.example-4808  (-----) [006] .... 176340.160279: tracing_mark_write: B|4808|Record View#draw()`,
  `com.example-4808  (-----) [006] .... 176340.160674: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.162005: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.162012: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.162018: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.241206: tracing_mark_write: B|4808|Choreographer#onVsync 4573954
com.example-4808  (-----) [006] .... 176340.241224: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.241240: tracing_mark_write: B|4808|Choreographer#doFrame 4573954
com.example-4808  (-----) [006] .... 176340.241253: tracing_mark_write: B|4808|animation
com.example-4808  (-----) [006] .... 176340.251574: tracing_mark_write: B|4808|Choreographer#scheduleVsyncLocked
com.example-4808  (-----) [006] .... 176340.251669: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.252254: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.252268: tracing_mark_write: B|4808|traversal
com.example-4808  (-----) [006] .... 176340.252353: tracing_mark_write: B|4808|draw
com.example-4808  (-----) [006] .... 176340.252410: tracing_mark_write: B|4808|Record View#draw()
com.example-4808  (-----) [006] .... 176340.253061: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.254615: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.254634: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.254655: tracing_mark_write: E|4808
com.example-4808  (-----) [006] .... 176340.341376: tracing_mark_write: B|4808|Choreographer#onVsync 4573957`,
];

describe("getFrameTimes", () => {
  it("retrieves frame times", () => {
    const frameParser = new FrameTimeParser();
    expect(frameParser.getFrameTimes(SAMPLE_ATRACES[0], "4808")).toEqual([22.782999992370605]);
    expect(frameParser.getFrameTimes(SAMPLE_ATRACES[1], "4808")).toEqual([
      14.663000017404556, 13.41499999165535,
    ]);
  });

  it("returns no frame times for an empty batch", () => {
    expect(new FrameTimeParser().getFrameTimes("", "4808")).toEqual([]);
  });
});

describe("getFps", () => {
  it("computes fps from frame times over the interval", () => {
    // 10 frames of 16.67ms over 500ms with an idle UI thread: 10 frames + 20 idle frames
    expect(FrameTimeParser.getFps(Array(10).fill(1000 / 60), 500, 0, 60)).toBeCloseTo(60);
    // 10 frames of 50ms (500ms total) over 500ms: 20fps
    expect(FrameTimeParser.getFps(Array(10).fill(50), 500, 0, 60)).toBeCloseTo(20);
  });

  it("targets the given refresh rate", () => {
    // 10 frames of 8.33ms over 500ms with an idle UI thread: 10 frames + 50 idle frames
    expect(FrameTimeParser.getFps(Array(10).fill(1000 / 120), 500, 0, 120)).toBeCloseTo(120);
    // The same frames scored against 60 Hz are capped at 60
    expect(FrameTimeParser.getFps(Array(10).fill(1000 / 120), 500, 0, 60)).toBeCloseTo(60);
    // 10 frames of 50ms over 500ms: 20fps whatever the target
    expect(FrameTimeParser.getFps(Array(10).fill(50), 500, 0, 120)).toBeCloseTo(20);
  });

  it("does not return NaN when the interval is 0", () => {
    expect(FrameTimeParser.getFps([], 0, 0, 60)).toBe(60);
    expect(FrameTimeParser.getFps([], 0, 50, 60)).toBe(30);
    expect(FrameTimeParser.getFps([], 0, 100, 60)).toBe(0);
    expect(FrameTimeParser.getFps([], -1, 0, 60)).toBe(60);
    expect(FrameTimeParser.getFps([], 0, 50, 120)).toBe(60);
  });
});
