import { ChildProcess, execFileSync, SpawnSyncReturns } from "child_process";
import { Logger } from "@lantern/logger";
import { executeAsync } from "./shell";

export interface AdbOptions {
  /** Device serial, passed as `adb -s <serial>`; omitted when adb should pick (e.g. `adb devices`). */
  serial?: string;
}

/** The full adb argv for `args`, targeting `serial` when one is given. */
export const adbArgs = (args: string[], serial?: string): string[] =>
  serial ? ["-s", serial, ...args] : args;

/**
 * Runs `adb <args>` synchronously and returns its stdout. Arguments are an argv array so that a
 * value containing spaces (a file path, a shell pipeline meant for the device) is passed through
 * untouched. Throws like `execFileSync` on a non-zero exit, after logging stderr at debug level.
 */
export const adb = (args: string[], { serial }: AdbOptions = {}): string => {
  const argv = adbArgs(args, serial);
  try {
    return execFileSync("adb", argv, { stdio: "pipe", encoding: "utf8" });
  } catch (error: unknown) {
    // The Error object carries the whole spawnSync result; stderr is missing when adb itself
    // could not be spawned
    const stderr = (error as Partial<SpawnSyncReturns<string>>).stderr;
    Logger.debug(
      `Error while executing "adb ${argv.join(" ")}": ${stderr ? stderr.toString() : String(error)}`
    );
    throw error;
  }
};

/** Runs `adb <args>` synchronously, discarding its output (for commands whose output is huge). */
export const adbIgnoringOutput = (args: string[], { serial }: AdbOptions = {}): void => {
  execFileSync("adb", adbArgs(args, serial), { stdio: "ignore" });
};

/** Spawns a long-running `adb <args>` (atrace, screenrecord, the on-device profiler). */
export const adbAsync = (
  args: string[],
  { serial, logStderr = true }: AdbOptions & { logStderr?: boolean } = {}
): ChildProcess => executeAsync(["adb", ...adbArgs(args, serial)], { logStderr });
