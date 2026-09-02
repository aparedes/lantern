import type { ChildProcess } from "child_process";

/** `signal SIGINT` / `code 1`, for end-of-session reasons. */
export const describeExit = (code: number | null, signal: NodeJS.Signals | null) =>
  signal ? `signal ${signal}` : `code ${code}`;

/** How long a profiler gets to exit after SIGINT before it is SIGKILLed. */
export const KILL_AFTER_MS = 3000;

/**
 * SIGINT lets a profiler tear down cleanly (atrace, instruments taps...); one stuck on a dead
 * connection is SIGKILLed after `killAfterMs` so that stopping never leaves a process behind.
 */
export const terminateChild = (
  child: ChildProcess,
  {
    killAfterMs = KILL_AFTER_MS,
    onEscalate,
  }: { killAfterMs?: number; onEscalate?: () => void } = {}
) => {
  child.kill("SIGINT");
  const timer = setTimeout(() => {
    onEscalate?.();
    child.kill("SIGKILL");
  }, killAfterMs);
  // Must not keep the CLI alive once the child is gone, nor fire after it exited
  timer.unref();
  child.once("close", () => clearTimeout(timer));
};
