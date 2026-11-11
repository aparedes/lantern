import { AppInfo, Measure, Platform, TestCaseResult } from "@lantern/types";
import type { TypedSocket } from "./typedSocket";

export interface SocketData {
  isMeasuring: boolean;
  bundleId: string | null;
  results: TestCaseResult[];
  platform: Platform;
  apps: AppInfo[];
}

export interface ServerToClientEvents {
  updateState: (state: SocketData) => void;
  /**
   * Measures appended to the single iteration of the last result since the previous
   * `updateState` / `addMeasures` on this connection.
   */
  addMeasures: (measures: Measure[]) => void;
  sendError(error: unknown): void;
}

export interface ClientToServerEvents {
  start: () => void;
  stop: () => void;
  reset: () => void;
  autodetectBundleId: () => void;
  setBundleId: (bundleId: string) => void;
  listApps: () => void;
}

/**
 * Connection lifecycle, dispatched locally by the web app client (never sent over the wire).
 * socket.io reserved the same two event names, so listeners did not have to change.
 */
export interface SocketLifecycleEvents {
  connect: () => void;
  disconnect: (reason: string) => void;
}

/** The measure server's end of the connection with the (single) web app client. */
export type SocketType = TypedSocket<ServerToClientEvents, ClientToServerEvents>;

/** The web app's end of the same connection. */
export type ClientSocketType = TypedSocket<
  ClientToServerEvents,
  ServerToClientEvents & SocketLifecycleEvents
> & {
  /** Closes the connection for good — no reconnection attempt follows. */
  close(): void;
};

export enum SocketEvents {
  START = "start",
  STOP = "stop",
  RESET = "reset",
  AUTODETECT_BUNDLE_ID = "autodetectBundleId",
  SET_BUNDLE_ID = "setBundleId",
  LIST_APPS = "listApps",
  UPDATE_STATE = "updateState",
  ADD_MEASURES = "addMeasures",
  SEND_ERROR = "sendError",
  CONNECT = "connect",
  DISCONNECT = "disconnect",
}
