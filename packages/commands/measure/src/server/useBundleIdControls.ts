import { profiler } from "@lantern/profiler";
import { useEffect, useRef } from "react";
import { SocketType, SocketData, SocketEvents } from "../socket/socketInterface";

export const useBundleIdControls = (
  socket: SocketType,
  setState: (state: Partial<SocketData>) => void,
  stop: () => void
) => {
  // `setState` and `stop` are recreated on every render (they aren't memoized upstream), so this
  // effect re-runs on every state change. Guard the "populate on connect" call with a ref so it
  // fires once per connection instead of looping: each `listApps()` resolution calls `setState`,
  // which would otherwise re-trigger this effect and call `listApps()` again forever.
  const hasListedAppsOnConnect = useRef(false);

  useEffect(() => {
    const listApps = () =>
      profiler
        .listApps()
        .then((apps) => setState({ apps }))
        .catch((error) =>
          socket.emit(
            SocketEvents.SEND_ERROR,
            error instanceof Error ? error.message : "unknown error"
          )
        );

    socket.on(SocketEvents.SET_BUNDLE_ID, (bundleId) => {
      setState({
        bundleId,
      });
    });

    socket.on(SocketEvents.AUTODETECT_BUNDLE_ID, () => {
      stop();

      profiler
        .detectCurrentBundleId()
        .then((bundleId) => {
          setState({
            bundleId,
          });
          listApps();
        })
        .catch((error) =>
          socket.emit(
            SocketEvents.SEND_ERROR,
            error instanceof Error ? error.message : "unknown error"
          )
        );
    });

    socket.on(SocketEvents.LIST_APPS, listApps);

    // Populate the picker as soon as the web app connects (once, not on every re-run of
    // this effect — see the ref comment above).
    if (!hasListedAppsOnConnect.current) {
      hasListedAppsOnConnect.current = true;
      listApps();
    }

    return () => {
      socket.removeAllListeners(SocketEvents.SET_BUNDLE_ID);
      socket.removeAllListeners(SocketEvents.AUTODETECT_BUNDLE_ID);
      socket.removeAllListeners(SocketEvents.LIST_APPS);
    };
  }, [setState, socket, stop]);
};
