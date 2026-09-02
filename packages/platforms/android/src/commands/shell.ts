import { Logger } from "@lantern/logger";
import { execSync, spawn, ChildProcess, SpawnSyncReturns } from "child_process";
import { createInterface } from "readline";

export const executeCommand = (command: string): string => {
  try {
    return execSync(command, { stdio: "pipe" }).toString();
  } catch (error: unknown) {
    // The Error object will contain the entire result from child_process.spawnSync()
    // (source: https://nodejs.org/api/child_process.html#child_processexecsynccommand-options)
    // stderr can be missing (e.g. when the command could not be spawned at all)
    const stderr = (error as Partial<SpawnSyncReturns<Buffer>>).stderr;
    Logger.debug(
      `Error while executing command "${command}": ${stderr ? stderr.toString() : String(error)}`
    );
    throw error;
  }
};

const childProcesses: ChildProcess[] = [];

export const cleanup = () => {
  childProcesses.forEach((child) => {
    child.kill();
  });
};

const exit = () => {
  cleanup();
  process.exit();
};

declare const global: {
  Flipper: unknown;
};

if (!global.Flipper) {
  process.on("SIGINT", exit); // CTRL+C
  process.on("SIGQUIT", exit); // Keyboard quit
  process.on("SIGTERM", exit); // `kill` command
}

/**
 * In AWS when we properly kill the process termination gets logged in stderr with a weird log
 */
export const canIgnoreAwsTerminationError = (log: string) =>
  log.includes("Terminated              LD_LIBRARY_PATH");

/**
 * A command is either a single string split on spaces, or an already split argv array.
 * Use the array form when arguments (e.g. file paths) may contain spaces.
 */
export type Command = string | string[];

const toArgv = (command: Command): string[] =>
  Array.isArray(command) ? command : command.split(" ");

const toCommandLabel = (command: Command): string =>
  Array.isArray(command) ? command.join(" ") : command;

export const executeAsync = (
  command: Command,
  { logStderr } = {
    logStderr: true,
  }
): ChildProcess => {
  const [executable, ...args] = toArgv(command);
  const commandLabel = toCommandLabel(command);

  const childProcess = spawn(executable, args);

  childProcess.stdout?.on("end", () => {
    Logger.debug(`Process for ${commandLabel} ended`);
  });

  childProcess.stderr?.on("data", (data) => {
    if (logStderr && !canIgnoreAwsTerminationError(data.toString()))
      Logger.error(`Process for ${commandLabel} errored with ${data.toString()}`);
  });

  childProcess.on("close", (code) => {
    Logger.debug(`child process exited with code ${code}`);

    const index = childProcesses.indexOf(childProcess);
    if (index !== -1) childProcesses.splice(index, 1);

    const AUTHORIZED_CODES = [
      0, // Success
      130, // SIGINT
      137, // SIGKILL
      143, // SIGTERM
      255, // SSH EXECUTION STOPPED
    ];

    // SIGKILL or SIGTERM are likely to be normal, since we request termination from JS side
    // Never throw here: an exception thrown from an event handler is uncaught and kills the CLI
    if (code && !AUTHORIZED_CODES.includes(code)) {
      Logger.error(`Process for ${commandLabel} exited with code ${code}`);
    }
  });

  childProcess.on("error", (err) => {
    Logger.error(`Process for ${commandLabel} errored with ${err}`);
  });

  childProcesses.push(childProcess);

  return childProcess;
};

/**
 * Spawns a process whose stdout is line oriented (NDJSON), calling `onLine` with each complete
 * line, however the chunks were split. A trailing partial line is delivered once completed, or
 * when stdout ends.
 */
export const executeLineProcess = (command: Command, onLine: (line: string) => void) => {
  const process = executeAsync(command, {
    logStderr: false,
  });

  if (process.stdout) {
    createInterface({ input: process.stdout }).on("line", onLine);
  }

  return process;
};
