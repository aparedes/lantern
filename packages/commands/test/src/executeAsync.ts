import { spawn } from "child_process";
import { LanternError } from "@lantern/profiler-protocol";

/**
 * Runs a user-provided command (`--testCommand`, `--beforeEachCommand`...). Its output, stdout
 * included, is forwarded to stderr: stdout only carries Lantern's own result (see `--json`).
 */
export const executeAsync = (command: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, { shell: true });

    // Chunks already carry their own line breaks, so write them through verbatim
    child.stdout.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      // Commands can choose to log diagnostic data on stderr, not necessarily errors
      // Let's just log them and not pollute with a noisy Logger.error
      process.stderr.write(data);
    });

    child.on("error", (error) => {
      reject(
        new LanternError(
          "TEST_COMMAND_FAILED",
          `Error when running "${command}": ${error.message}`,
          {
            details: { command },
            cause: error,
          }
        )
      );
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(
          new LanternError(
            "TEST_COMMAND_FAILED",
            `Error when running "${command}": exited with code ${code}`,
            { details: { command, exitCode: code } }
          )
        );
        return;
      }
      resolve();
    });
  });
