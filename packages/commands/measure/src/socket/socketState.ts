import { DeviceSpecs, Measure, Platform, TestCaseIterationResult } from "@lantern/types";
import { useState, useEffect, useCallback, useRef } from "react";
import { SocketType, SocketData, SocketEvents } from "./socketInterface";

export const useSocketState = (socket: SocketType, platform: Platform) => {
  const [state, _setState] = useState<SocketData>({
    isMeasuring: false,
    bundleId: null,
    results: [],
    platform,
    apps: [],
  });

  // Stable identity: the consumers register socket listeners in effects that depend on it, so a
  // new function every render would tear down and re-register those listeners on every state
  // change.
  const setState = useCallback(
    (newState: Partial<SocketData> | ((previousState: SocketData) => SocketData)) => {
      _setState(
        typeof newState === "function"
          ? newState
          : (previousState) => ({
              ...previousState,
              ...newState,
            })
      );
    },
    []
  );

  // What this connection was last told. A new connection (a new `socket`) starts from nothing
  // and gets the whole state, which is also how a reconnecting web app catches up.
  const lastEmitted = useRef<{ socket: SocketType; state: SocketData } | null>(null);

  useEffect(() => {
    const previous = lastEmitted.current;
    lastEmitted.current = { socket, state };

    const appended =
      previous?.socket === socket ? getAppendedMeasures(previous.state, state) : null;
    if (appended) {
      socket.emit(SocketEvents.ADD_MEASURES, appended);
    } else {
      socket.emit(SocketEvents.UPDATE_STATE, state);
    }
  }, [state, socket]);

  return [state, setState] as const;
};

/** The single iteration of a live result. `measures` must not be mutated afterwards. */
const buildLiveIteration = (measures: Measure[]): TestCaseIterationResult => ({
  measures,
  time: measures.at(-1)?.time ?? 0,
  status: "SUCCESS",
});

const replaceLastIteration = (state: SocketData, measures: Measure[]): SocketData => ({
  ...state,
  results: [
    ...state.results.slice(0, -1),
    { ...state.results[state.results.length - 1], iterations: [buildLiveIteration(measures)] },
  ],
});

export const updateMeasuresReducer = (state: SocketData, measures: Measure[]): SocketData => {
  // A poll can still land after RESET emptied the results: there is no result to update, and
  // spreading `undefined` would fabricate a nameless one.
  if (state.results.length === 0) return state;

  // A snapshot, not the measurer's own (mutable) array: `getAppendedMeasures` compares states
  return replaceLastIteration(state, [...measures]);
};

/** Applies an `addMeasures` event: appends to the single iteration of the last result. */
export const appendMeasuresReducer = (state: SocketData, measures: Measure[]): SocketData => {
  if (state.results.length === 0) return state;

  const current = state.results[state.results.length - 1].iterations[0]?.measures ?? [];

  return replaceLastIteration(state, [...current, ...measures]);
};

export const addNewResultReducer = (
  state: SocketData,
  name: string,
  specs: DeviceSpecs
): SocketData => ({
  ...state,
  results: [
    ...state.results,
    {
      name,
      iterations: [],
      status: "SUCCESS",
      specs,
    },
  ],
});

/**
 * The measures `next` appended to `previous`, when that is the only difference between the
 * two states — otherwise null, and the whole state has to be sent. Compares by identity:
 * the reducers above keep every untouched part of the state and every already-known measure.
 */
export const getAppendedMeasures = (previous: SocketData, next: SocketData): Measure[] | null => {
  const { results: previousResults, ...previousRest } = previous;
  const { results: nextResults, ...nextRest } = next;
  const restKeys = Object.keys(nextRest) as (keyof typeof nextRest)[];
  if (restKeys.some((key) => previousRest[key] !== nextRest[key])) return null;

  if (nextResults.length === 0 || previousResults.length !== nextResults.length) return null;
  const last = nextResults.length - 1;
  if (nextResults.slice(0, last).some((result, i) => result !== previousResults[i])) return null;

  const { iterations: previousIterations, ...previousLast } = previousResults[last];
  const { iterations: nextIterations, ...nextLast } = nextResults[last];
  const lastKeys = Object.keys(nextLast) as (keyof typeof nextLast)[];
  if (
    Object.keys(previousLast).length !== lastKeys.length ||
    lastKeys.some((key) => previousLast[key] !== nextLast[key])
  ) {
    return null;
  }

  if (nextIterations.length !== 1 || previousIterations.length > 1) return null;
  const previousMeasures = previousIterations[0]?.measures ?? [];
  const nextMeasures = nextIterations[0].measures;
  if (nextMeasures.length <= previousMeasures.length) return null;
  // Same run: a restart (new app process) replaces the measures with new objects
  if (
    previousMeasures.length > 0 &&
    nextMeasures[previousMeasures.length - 1] !== previousMeasures[previousMeasures.length - 1]
  ) {
    return null;
  }

  return nextMeasures.slice(previousMeasures.length);
};
