import { describe, it, expect } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { DeviceSpecs, Measure } from "@lantern/types";
import {
  addNewResultReducer,
  appendMeasuresReducer,
  getAppendedMeasures,
  updateMeasuresReducer,
  useSocketState,
} from "../../socket/socketState";
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  SocketEvents,
} from "../../socket/socketInterface";
import { TypedSocketBase } from "../../socket/typedSocket";

const emptyState: SocketData = {
  isMeasuring: false,
  bundleId: null,
  results: [],
  platform: "android",
  apps: [],
};

const specs: DeviceSpecs = { refreshRate: 60 };

const aMeasure = (time = 0): Measure => ({ cpu: { perName: {}, perCore: {} }, ram: 100, time });

describe("updateMeasuresReducer", () => {
  it("leaves the state untouched when there is no result to update", () => {
    // A poll can still land after RESET emptied the results.
    const state = updateMeasuresReducer(emptyState, [aMeasure()]);

    expect(state).toBe(emptyState);
    expect(state.results).toEqual([]);
  });

  it("replaces the measures of the last result with a copy, timed by the last measure", () => {
    const withResults = addNewResultReducer(
      addNewResultReducer(emptyState, "com.example", specs),
      "com.example (2)",
      specs
    );

    const measures = [aMeasure(500), aMeasure(1000)];
    const state = updateMeasuresReducer(withResults, measures);

    expect(state.results).toHaveLength(2);
    expect(state.results[0]).toBe(withResults.results[0]);
    expect(state.results[1].name).toBe("com.example (2)");
    expect(state.results[1].iterations).toEqual([{ measures, time: 1000, status: "SUCCESS" }]);
    expect(state.results[1].iterations[0].measures).not.toBe(measures);
    expect(state.results[1].iterations[0].measures[0]).toBe(measures[0]);
  });

  it("is not affected by the caller appending to its own array afterwards", () => {
    const withResult = addNewResultReducer(emptyState, "com.example", specs);
    const measures = [aMeasure(500)];
    const state = updateMeasuresReducer(withResult, measures);

    measures.push(aMeasure(1000));

    expect(state.results[0].iterations[0].measures).toHaveLength(1);
  });

  it("times an empty measure list at 0", () => {
    const withResult = addNewResultReducer(emptyState, "com.example", specs);

    expect(updateMeasuresReducer(withResult, []).results[0].iterations[0].time).toBe(0);
  });
});

describe("addNewResultReducer", () => {
  it("stores the specs as given", () => {
    const fullSpecs: DeviceSpecs = { refreshRate: 120, platform: "android", deviceName: "Pixel 7" };
    const state = addNewResultReducer(emptyState, "com.example", fullSpecs);

    expect(state.results).toEqual([
      { name: "com.example", iterations: [], status: "SUCCESS", specs: fullSpecs },
    ]);
    expect(state.results[0].specs).toBe(fullSpecs);
  });
});

describe("appendMeasuresReducer", () => {
  it("leaves the state untouched when there is no result", () => {
    expect(appendMeasuresReducer(emptyState, [aMeasure()])).toBe(emptyState);
  });

  it("appends to the measures of the last result", () => {
    const first = aMeasure(500);
    const second = aMeasure(1000);
    const previous = updateMeasuresReducer(addNewResultReducer(emptyState, "com.example", specs), [
      first,
    ]);

    const state = appendMeasuresReducer(previous, [second]);

    expect(state.results[0].iterations).toEqual([
      { measures: [first, second], time: 1000, status: "SUCCESS" },
    ]);
    expect(state.results[0].iterations[0].measures[0]).toBe(first);
    expect(previous.results[0].iterations[0].measures).toHaveLength(1);
  });

  it("starts the iteration when the result has none yet", () => {
    const previous = addNewResultReducer(emptyState, "com.example", specs);
    const measure = aMeasure(500);

    expect(appendMeasuresReducer(previous, [measure]).results[0].iterations).toEqual([
      { measures: [measure], time: 500, status: "SUCCESS" },
    ]);
  });
});

describe("getAppendedMeasures", () => {
  const withResult = addNewResultReducer(emptyState, "com.example", specs);
  const withMeasures = (state: SocketData, measures: Measure[]) =>
    updateMeasuresReducer(state, measures);

  it("returns the measures appended after an empty result", () => {
    const measures = [aMeasure(500)];

    expect(getAppendedMeasures(withResult, withMeasures(withResult, measures))).toEqual(measures);
  });

  it("returns the measures appended after existing ones", () => {
    const [a, b] = [aMeasure(500), aMeasure(1000)];
    const previous = withMeasures(withResult, [a]);
    const next = withMeasures(previous, [a, b]);

    const appended = getAppendedMeasures(previous, next);

    expect(appended).toEqual([b]);
    expect(appended?.[0]).toBe(b);
  });

  it("returns several appended measures at once", () => {
    const [a, b, c] = [aMeasure(500), aMeasure(1000), aMeasure(1500)];
    const previous = withMeasures(withResult, [a]);

    expect(getAppendedMeasures(previous, withMeasures(previous, [a, b, c]))).toEqual([b, c]);
  });

  it("follows consecutive states of a measurer appending to one array in place", () => {
    const measurerArray: Measure[] = [aMeasure(500)];
    const first = withMeasures(withResult, measurerArray);
    measurerArray.push(aMeasure(1000));
    const second = withMeasures(first, measurerArray);

    expect(getAppendedMeasures(first, second)).toEqual([measurerArray[1]]);
  });

  it("returns null when something else of the state changed", () => {
    const [a, b] = [aMeasure(500), aMeasure(1000)];
    const previous = withMeasures(withResult, [a]);
    const next = withMeasures(previous, [a, b]);

    expect(getAppendedMeasures(previous, { ...next, isMeasuring: true })).toBeNull();
    expect(getAppendedMeasures(previous, { ...next, bundleId: "com.example" })).toBeNull();
    expect(getAppendedMeasures(previous, { ...next, apps: [] })).toBeNull();
    expect(getAppendedMeasures(previous, { ...next, platform: "ios" })).toBeNull();
  });

  it("returns null when a result was added or removed", () => {
    const previous = withMeasures(withResult, [aMeasure(500)]);
    const added = addNewResultReducer(previous, "com.example (2)", specs);

    expect(getAppendedMeasures(previous, added)).toBeNull();
    expect(getAppendedMeasures(added, previous)).toBeNull();
    expect(getAppendedMeasures(previous, emptyState)).toBeNull();
    expect(getAppendedMeasures(emptyState, emptyState)).toBeNull();
  });

  it("returns null when an earlier result changed", () => {
    const [a, b] = [aMeasure(500), aMeasure(1000)];
    const two = addNewResultReducer(withMeasures(withResult, [a]), "com.example (2)", specs);
    const previous = withMeasures(two, [aMeasure(500)]);
    const next = {
      ...previous,
      results: [{ ...previous.results[0], name: "renamed" }, previous.results[1]],
    };

    expect(getAppendedMeasures(previous, withMeasures(next, [aMeasure(500), b]))).toBeNull();
  });

  it("returns null when the name or specs of the last result changed", () => {
    const a = aMeasure(500);
    const previous = withMeasures(withResult, [a]);
    const next = withMeasures(previous, [a, aMeasure(1000)]);
    const [last] = next.results;

    expect(
      getAppendedMeasures(previous, { ...next, results: [{ ...last, name: "other" }] })
    ).toBeNull();
    expect(
      getAppendedMeasures(previous, { ...next, results: [{ ...last, specs: { refreshRate: 60 } }] })
    ).toBeNull();
    expect(
      getAppendedMeasures(previous, { ...next, results: [{ ...last, specs: undefined }] })
    ).toBeNull();
    expect(
      getAppendedMeasures(previous, { ...next, results: [{ ...last, score: 90 }] })
    ).toBeNull();
  });

  it("returns null when the measures were replaced by a new run", () => {
    const previous = withMeasures(withResult, [aMeasure(500), aMeasure(1000)]);

    // fewer measures
    expect(getAppendedMeasures(previous, withMeasures(previous, [aMeasure(500)]))).toBeNull();
    // same length, different objects
    expect(
      getAppendedMeasures(previous, withMeasures(previous, [aMeasure(500), aMeasure(1000)]))
    ).toBeNull();
    // longer, but not a continuation
    expect(
      getAppendedMeasures(
        previous,
        withMeasures(previous, [aMeasure(500), aMeasure(1000), aMeasure(1500)])
      )
    ).toBeNull();
  });

  it("returns null when nothing was appended", () => {
    const previous = withMeasures(withResult, [aMeasure(500)]);

    expect(getAppendedMeasures(previous, previous)).toBeNull();
    expect(getAppendedMeasures(withResult, withResult)).toBeNull();
    expect(
      getAppendedMeasures(
        previous,
        withMeasures(previous, previous.results[0].iterations[0].measures)
      )
    ).toBeNull();
  });

  it("returns null when the iterations are not the single live one", () => {
    const previous = withMeasures(withResult, [aMeasure(500)]);
    const [last] = previous.results;
    const iteration = last.iterations[0];
    const next = {
      ...previous,
      results: [{ ...last, iterations: [iteration, iteration] }],
    };

    expect(getAppendedMeasures(previous, next)).toBeNull();
    expect(getAppendedMeasures(next, previous)).toBeNull();
  });

  it("round-trips: applying the delta to the previous state yields the next one", () => {
    const [a, b, c] = [aMeasure(500), aMeasure(1000), aMeasure(1500)];
    const previous = withMeasures(withResult, [a]);
    const next = withMeasures(previous, [a, b, c]);

    const appended = getAppendedMeasures(previous, next);

    expect(appended).not.toBeNull();
    expect(appendMeasuresReducer(previous, appended ?? [])).toEqual(next);
  });

  it("round-trips from an empty result", () => {
    const next = withMeasures(withResult, [aMeasure(500)]);

    const appended = getAppendedMeasures(withResult, next);

    expect(appended).not.toBeNull();
    expect(appendMeasuresReducer(withResult, appended ?? [])).toEqual(next);
  });
});

/** The server's end of a connection: records what is sent, and lets a test play the client. */
class FakeServerSocket extends TypedSocketBase<ServerToClientEvents, ClientToServerEvents> {
  readonly emitted: [event: string, ...args: unknown[]][] = [];

  get connected() {
    return true;
  }

  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, ...args]);
  }

  disconnect() {}

  receive(event: string, ...args: unknown[]) {
    this.dispatch(event, args);
  }
}

describe("useSocketState", () => {
  it("sends the whole state again when the client asks for it, even after deltas", () => {
    const socket = new FakeServerSocket();
    const { result } = renderHook(() => useSocketState(socket, "android"));
    const setState = result.current[1];
    const first = aMeasure(500);

    act(() => setState((state) => addNewResultReducer(state, "com.example", specs)));
    act(() => setState((state) => updateMeasuresReducer(state, [first])));
    act(() => setState((state) => updateMeasuresReducer(state, [first, aMeasure(1000)])));
    // The client has only been sent a delta for the last two changes
    expect(socket.emitted.slice(-2).map(([event]) => event)).toEqual([
      SocketEvents.ADD_MEASURES,
      SocketEvents.ADD_MEASURES,
    ]);

    act(() => socket.receive(SocketEvents.REQUEST_STATE));

    expect(socket.emitted.at(-1)).toEqual([SocketEvents.UPDATE_STATE, result.current[0]]);
    expect(result.current[0].results[0].iterations[0].measures).toHaveLength(2);
  });
});
