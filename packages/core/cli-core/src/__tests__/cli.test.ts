import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { Logger } from "@lantern/logger";
import { LanternError } from "@lantern/profiler-protocol";
import { isJsonMode, printResult, registerJsonOption, reportError, runCli, setJsonMode } from "..";

/** Thrown by the `process.exit` spy so that the test process survives the call. */
class ExitSentinel extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
  throw new ExitSentinel(code);
}) as unknown as typeof process.exit);
const error = spyOn(Logger, "error").mockImplementation(() => {});
const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
// Commander prints its own usage errors and help on stderr / stdout
const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

const writtenJson = () => stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));

beforeEach(() => setJsonMode(false));

afterEach(() => {
  exit.mockClear();
  error.mockClear();
  stdout.mockClear();
  stderr.mockClear();
});

afterAll(() => mock.restore());

/** `lantern <name> [--json]`, running `action` */
const createProgram = (action: () => void) => {
  const program = new Command("lantern");
  registerJsonOption(program.command("get").option("--title <title>")).action(action);

  return program;
};

const run = (program: Command, ...args: string[]) =>
  runCli(program, ["bun", "lantern", ...args]).catch((failure: unknown) => {
    if (failure instanceof ExitSentinel) return failure.code;
    throw failure;
  });

describe("printResult", () => {
  it("prints one JSON line on stdout in JSON mode, without calling the human printer", () => {
    const human = mock();
    setJsonMode(true);

    printResult({ bundleId: "com.example" }, human);

    expect(stdout).toHaveBeenCalledWith('{"bundleId":"com.example"}\n');
    expect(human).not.toHaveBeenCalled();
  });

  it("hands the value to the human printer otherwise", () => {
    const human = mock();

    printResult({ bundleId: "com.example" }, human);

    expect(human).toHaveBeenCalledWith({ bundleId: "com.example" });
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("reportError", () => {
  it("logs the message and returns the code's exit code", () => {
    expect(reportError(new LanternError("NO_DEVICE", "No Android device connected"))).toBe(3);

    expect(error).toHaveBeenCalledWith("No Android device connected");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("also prints the envelope on stdout in JSON mode", () => {
    setJsonMode(true);

    reportError(
      new LanternError("NO_MEASURES", "No measures", { details: { bundleId: "com.example" } })
    );

    expect(writtenJson()).toEqual([
      {
        error: {
          code: "NO_MEASURES",
          message: "No measures",
          details: { bundleId: "com.example" },
        },
      },
    ]);
  });

  it("reports an unexpected error as INTERNAL", () => {
    setJsonMode(true);

    expect(reportError(new Error("boom"))).toBe(1);
    expect(writtenJson()).toEqual([{ error: { code: "INTERNAL", message: "boom" } }]);
  });
});

describe("runCli", () => {
  it("runs the action and does not exit on success", async () => {
    const action = mock();

    await run(createProgram(action), "get");

    expect(action).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("turns JSON mode on for an action run with --json", async () => {
    let jsonModeInAction: boolean | undefined;

    await run(
      createProgram(() => {
        jsonModeInAction = isJsonMode();
      }),
      "get",
      "--json"
    );

    expect(jsonModeInAction).toBe(true);
  });

  it("does not take another option's --json value for the flag", async () => {
    let jsonModeInAction: boolean | undefined;

    await run(
      createProgram(() => {
        jsonModeInAction = isJsonMode();
      }),
      "get",
      "--title",
      "--json"
    );

    expect(jsonModeInAction).toBe(false);
  });

  it("exits with the failure's exit code and prints its envelope", async () => {
    const program = createProgram(() => {
      throw new LanternError("AMBIGUOUS_DEVICE", "Several devices: pass --device");
    });

    expect(await run(program, "get", "--json")).toBe(3);
    expect(error).toHaveBeenCalledWith("Several devices: pass --device");
    expect(writtenJson()).toEqual([
      { error: { code: "AMBIGUOUS_DEVICE", message: "Several devices: pass --device" } },
    ]);
  });

  it("reports a usage error as INVALID_ARGUMENT with exit code 2", async () => {
    const action = mock();

    expect(await run(createProgram(action), "get", "--nope", "--json")).toBe(2);

    expect(action).not.toHaveBeenCalled();
    expect(writtenJson()).toEqual([
      {
        error: {
          code: "INVALID_ARGUMENT",
          message: "unknown option '--nope'",
          details: { commanderCode: "commander.unknownOption" },
        },
      },
    ]);
  });

  it("exits with 0 after --help", async () => {
    expect(await run(createProgram(mock()), "get", "--help")).toBe(0);
  });
});
