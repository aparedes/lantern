import { Command, CommanderError } from "commander";
import { Logger } from "@lantern/logger";
import { LanternError, exitCodeFor, toLanternError } from "@lantern/profiler-protocol";

/**
 * The output contract of every lantern command, for scripts and agents:
 *
 * - stdout only carries the command's result; logs go to stderr (see `@lantern/logger`).
 * - With `--json`, the result is a single JSON object on one stdout line — or, on failure,
 *   `{"error":{"code","message","details"}}` (see `ErrorEnvelope`).
 * - The exit code tells failures apart: see `exitCodeFor`.
 */

let jsonMode = false;

export const isJsonMode = () => jsonMode;

export const setJsonMode = (enabled: boolean) => {
  jsonMode = enabled;
};

/** Adds `--json` to a command whose action prints its result with `printResult`. */
export const registerJsonOption = (command: Command): Command =>
  command.option(
    "--json",
    "Print the result (or the error) as a single JSON object on stdout; logs stay on stderr"
  );

/**
 * Prints a command's result: as JSON on stdout in `--json` mode, else through `printHuman`
 * (nothing when it is omitted, e.g. when the logs already said it all).
 */
export const printResult = <T>(value: T, printHuman?: (value: T) => void) => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }

  printHuman?.(value);
};

export interface ErrorEnvelope {
  error: {
    code: LanternError["code"];
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Reports a failure the way the contract says: the message on stderr, plus the envelope on stdout
 * in `--json` mode. Returns the exit code to use.
 */
export const reportError = (error: unknown): number => {
  if (error instanceof CommanderError) {
    // `--help` / `--version`: not a failure
    if (error.exitCode === 0) return 0;

    // Commander already printed its own message (unknown option, missing argument...)
    const usageError = new LanternError("INVALID_ARGUMENT", error.message.replace(/^error: /, ""), {
      details: { commanderCode: error.code },
    });
    printResult<ErrorEnvelope>({ error: toEnvelope(usageError) });

    return exitCodeFor(usageError.code);
  }

  const lanternError = toLanternError(error);
  Logger.error(lanternError.message);
  printResult<ErrorEnvelope>({ error: toEnvelope(lanternError) });

  return exitCodeFor(lanternError.code);
};

const toEnvelope = ({ code, message, details }: LanternError): ErrorEnvelope["error"] =>
  details === undefined ? { code, message } : { code, message, details };

const forEachCommand = (command: Command, callback: (command: Command) => void) => {
  callback(command);
  command.commands.forEach((subCommand) => forEachCommand(subCommand, callback));
};

/**
 * Parses `argv` and runs the matching action, then exits with the contract's exit code when it
 * failed. The single top-level handler of every lantern entry point.
 */
export const runCli = async (program: Command, argv: readonly string[] = process.argv) => {
  // Parse errors happen before any action runs: the raw flag decides for those
  setJsonMode(argv.slice(2).includes("--json"));
  // The commands are built by now, so the override does not reach them through inheritance
  forEachCommand(program, (command) => command.exitOverride());
  // Once parsed, the option itself decides (a `--json` given as another option's value is not one)
  program.hook("preAction", (_program, actionCommand) => {
    setJsonMode(actionCommand.opts().json === true);
  });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    process.exit(reportError(error));
  }
};
