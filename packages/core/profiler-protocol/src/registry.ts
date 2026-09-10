import type { ProfilingSession } from "@lantern/types";

/** Sessions whose processes may still be running. */
const liveSessions = new Set<ProfilingSession>();

export const trackSession = (session: ProfilingSession) => {
  liveSessions.add(session);
};

export const untrackSession = (session: ProfilingSession) => {
  liveSessions.delete(session);
};

export const liveSessionCount = () => liveSessions.size;

/** Synchronous teardown of every live session, for signal handlers and manual exits. */
export const disposeAllSessions = () => {
  for (const session of Array.from(liveSessions)) {
    try {
      session.dispose();
    } catch {
      // Best effort: one session failing to tear down must not keep the others alive
    }
  }
};

const SIGNAL_EXIT_CODES: Record<"SIGINT" | "SIGQUIT" | "SIGTERM", number> = {
  SIGINT: 130, // CTRL+C
  SIGQUIT: 131, // Keyboard quit
  SIGTERM: 143, // `kill` command
};

export type SignalTarget = Pick<NodeJS.Process, "on" | "exit">;

const installed = new WeakSet<SignalTarget>();

/**
 * Terminates every live session (killing the profiler, atrace and the screen recorder, and
 * leaving the device's tracing off) before exiting on SIGINT / SIGQUIT / SIGTERM. Called once
 * by each CLI entry point, never at import time: a library consumer keeps its own handlers.
 */
export const installSignalHandlers = (target: SignalTarget = process) => {
  if (installed.has(target)) return;
  installed.add(target);

  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    target.on(signal as NodeJS.Signals, () => {
      disposeAllSessions();
      target.exit(code);
    });
  }
};
