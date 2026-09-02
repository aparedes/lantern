import { PerformanceMeasurer } from "@lantern/e2e";
import { Logger } from "@lantern/logger";
import { profiler, getPlatform } from "@lantern/profiler";
import { Measure } from "@lantern/types";
import React, { useCallback, useEffect } from "react";
import { HostAndPortInfo } from "./components/HostAndPortInfo";
import { SocketType, SocketEvents } from "../socket/socketInterface";
import { useSocketState, updateMeasuresReducer, addNewResultReducer } from "../socket/socketState";
import { useBundleIdControls } from "./useBundleIdControls";
import { useLogSocketEvents } from "../common/useLogSocketEvents";

export const ServerSocketConnectionApp = ({ socket, url }: { socket: SocketType; url: string }) => {
  useLogSocketEvents(socket);
  const [state, setState] = useSocketState(socket, getPlatform());
  const performanceMeasureRef = React.useRef<PerformanceMeasurer | null>(null);

  const stop = useCallback(async () => {
    performanceMeasureRef.current?.forceStop();
    setState({
      isMeasuring: false,
    });
  }, [setState]);

  useBundleIdControls(socket, setState, stop);

  useEffect(() => {
    const updateMeasures = (measures: Measure[]) =>
      setState((state) => updateMeasuresReducer(state, measures));
    const addNewResult = (bundleId: string, refreshRate: number) =>
      setState((state) =>
        addNewResultReducer(
          state,
          `${bundleId}${state.results.length > 0 ? ` (${state.results.length + 1})` : ""}`,
          refreshRate
        )
      );

    socket.on(SocketEvents.START, async () => {
      setState({
        isMeasuring: true,
      });

      if (!state.bundleId) {
        Logger.error("No bundle id provided");
        return;
      }

      const measurer = new PerformanceMeasurer(state.bundleId, {
        recordOptions: {
          record: false,
        },
      });
      performanceMeasureRef.current = measurer;

      try {
        // Both can take seconds (binary push, iOS tunnel bring-up): awaited, not blocking, so
        // the terminal UI and the socket stay responsive meanwhile
        await profiler.installProfilerOnDevice();
        const refreshRate = await profiler.detectDeviceRefreshRate();
        // Stopped (or restarted) while we were setting up: this run is no longer wanted
        if (performanceMeasureRef.current !== measurer) return;

        addNewResult(state.bundleId, refreshRate);
        await measurer.start(() => updateMeasures(measurer.measures || []));
        // Rejects when the profiler never reports a first measure or exits early
        await measurer.waitUntilMeasuring();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(message);
        socket.emit(SocketEvents.SEND_ERROR, message);
        if (performanceMeasureRef.current === measurer) {
          setState({ isMeasuring: false });
        }
      }
    });

    socket.on(SocketEvents.STOP, stop);

    socket.on(SocketEvents.RESET, () => {
      stop();
      setState({
        results: [],
      });
    });

    return () => {
      socket.removeAllListeners(SocketEvents.START);
      socket.removeAllListeners(SocketEvents.STOP);
      socket.removeAllListeners(SocketEvents.RESET);
    };
  }, [setState, socket, state.bundleId, stop]);

  return (
    <>
      <HostAndPortInfo url={url} platform={getPlatform()} />
    </>
  );
};
