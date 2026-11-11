import { Measure } from "@lantern/types";
import { useEffect, useState } from "react";
import { SocketData, SocketEvents } from "../socket/socketInterface";
import { appendMeasuresReducer } from "../socket/socketState";
import { socket } from "./socket";

export const useMeasures = () => {
  const [state, setState] = useState<SocketData>();

  useEffect(() => {
    // A delta can only follow a full state on the same connection; one arriving first is
    // ignored, and the full state requested below brings this client up to date
    const addMeasures = (measures: Measure[]) =>
      setState((current) => (current ? appendMeasuresReducer(current, measures) : current));

    socket.on(SocketEvents.UPDATE_STATE, setState);
    socket.on(SocketEvents.ADD_MEASURES, addMeasures);
    // The state the server sends on connect may have arrived before these listeners existed
    socket.emit(SocketEvents.REQUEST_STATE);

    return () => {
      socket.off(SocketEvents.UPDATE_STATE, setState);
      socket.off(SocketEvents.ADD_MEASURES, addMeasures);
    };
  }, []);

  return {
    bundleId: state?.bundleId ?? null,
    autodetect: () => {
      socket.emit(SocketEvents.AUTODETECT_BUNDLE_ID);
    },
    setBundleId: (bundleId: string) => {
      socket.emit(SocketEvents.SET_BUNDLE_ID, bundleId);
    },
    results: state?.results ?? [],
    isMeasuring: state?.isMeasuring ?? false,
    platform: state?.platform ?? "android",
    apps: state?.apps ?? [],
    refreshApps: () => {
      socket.emit(SocketEvents.LIST_APPS);
    },
    start: () => {
      socket.emit(SocketEvents.START);
    },
    stop: () => {
      socket.emit(SocketEvents.STOP);
    },
    reset: () => {
      socket.emit(SocketEvents.RESET);
    },
  };
};
