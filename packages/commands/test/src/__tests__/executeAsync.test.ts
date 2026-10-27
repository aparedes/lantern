import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { LanternError } from "@lantern/profiler-protocol";
import { executeAsync } from "../executeAsync";

const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

afterEach(() => {
  stdout.mockClear();
  stderr.mockClear();
});

afterAll(() => mock.restore());

const written = (spy: typeof stderr) => spy.mock.calls.map(([chunk]) => String(chunk)).join("");

describe("executeAsync", () => {
  it("forwards the command's stdout and stderr to stderr, leaving stdout to Lantern", async () => {
    await executeAsync("echo from-stdout; echo from-stderr >&2");

    expect(written(stderr)).toContain("from-stdout");
    expect(written(stderr)).toContain("from-stderr");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("rejects with TEST_COMMAND_FAILED and the exit code when the command fails", async () => {
    const failure = await executeAsync("exit 3").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LanternError);
    expect(failure).toMatchObject({
      code: "TEST_COMMAND_FAILED",
      message: 'Error when running "exit 3": exited with code 3',
      details: { command: "exit 3", exitCode: 3 },
    });
  });
});
