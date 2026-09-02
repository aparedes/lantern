import { Logger } from "@lantern/logger";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";

/**
 * In AWS when we properly kill the process termination gets logged in stderr with a weird log
 */
export const canIgnoreAwsTerminationError = (log: string) =>
  log.includes("Terminated              LD_LIBRARY_PATH");

/**
 * Spawns `argv[0]` with the remaining arguments (never through a shell), logging its stderr and
 * an unexpected exit code. The caller owns the returned process.
 */
export const executeAsync = (
  argv: string[],
  { logStderr } = {
    logStderr: true,
  }
): ChildProcess => {
  const [executable, ...args] = argv;
  const commandLabel = argv.join(" ");

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

  return childProcess;
};

/**
 * Spawns a process whose stdout is line oriented (NDJSON), calling `onLine` with each complete
 * line, however the chunks were split. A trailing partial line is delivered once completed, or
 * when stdout ends.
 */
export const executeLineProcess = (argv: string[], onLine: (line: string) => void) => {
  const process = executeAsync(argv, {
    logStderr: false,
  });

  if (process.stdout) {
    createInterface({ input: process.stdout }).on("line", onLine);
  }

  return process;
};
