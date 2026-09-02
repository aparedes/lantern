import { Logger } from "@lantern/logger";
import { executeAsync, executeCommand } from "./shell";
import { ChildProcess } from "child_process";
import { waitFor } from "../utils/waitFor";
import { isDeviceProcessRunning } from "./isDeviceProcessRunning";

const RECORDING_FOLDER = "/data/local/tmp/";
const START_RECORDING_TIMEOUT = 10000;
const STOP_RECORDING_TIMEOUT = 10000;

export class ScreenRecorder {
  private fileName;
  private process?: ChildProcess = undefined;
  private recordingStartTime = 0;

  constructor(file: string) {
    this.fileName = file;
  }

  async startRecording({
    bitRate = 8000000,
    size,
  }: {
    bitRate?: number;
    size?: string;
  } = {}): Promise<void> {
    const filePath = `${RECORDING_FOLDER}${this.fileName}`;

    const process = executeAsync([
      "adb",
      "shell",
      "screenrecord",
      filePath,
      "--bit-rate",
      `${bitRate}`,
      ...(size ? ["--size", size] : []),
      "--verbose",
    ]);
    this.process = process;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        callback();
      };

      const timeoutId = setTimeout(
        () =>
          settle(() =>
            reject(new Error(`Screen recording did not start within ${START_RECORDING_TIMEOUT}ms`))
          ),
        START_RECORDING_TIMEOUT
      );

      process.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("Content area is")) {
          settle(resolve);
        }
      });
      process.on("error", (error) => {
        settle(() => reject(new Error(`Screen recording failed to start: ${error.message}`)));
      });
      process.on("close", (code) => {
        settle(() =>
          reject(new Error(`Screen recording process exited with code ${code} before starting`))
        );
      });
    });

    Logger.info("Recording started");
    this.recordingStartTime = performance.now();
  }

  async stopRecording(): Promise<void> {
    if (!this.process) return;

    // Wait an arbitrary 5 seconds to make sure the recording captures everything we want
    // Otherwise, sometimes we miss the end of the video
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const process = this.process;
    this.process = undefined;

    // Killing the host `adb` process does not reliably stop `screenrecord` on the device, and
    // screenrecord needs SIGINT to finalize the video file: signal the device-side process directly
    try {
      executeCommand("adb shell pkill -INT screenrecord");
    } catch {
      Logger.warn("Could not send SIGINT to screenrecord on the device, killing adb instead");
      process.kill("SIGINT");
    }

    // Wait for the device-side process to stop running before pulling the file
    await waitFor(() => !isDeviceProcessRunning("screenrecord"), {
      timeout: STOP_RECORDING_TIMEOUT,
      checkInterval: 100,
      errorMessage: "ERROR: screenrecord still running after timeout, it should have been stopped",
    });

    // The adb process normally exits with screenrecord, make sure it does not linger around
    process.kill();

    // Wait an arbitrary time to ensure we don't end up with a corrupted video
    await new Promise((resolve) => setTimeout(resolve, 500));

    Logger.info("Recording stopped");
  }

  getRecordingStartTime(): number {
    return this.recordingStartTime;
  }

  /**
   * Synchronous best-effort teardown for signal handlers: signals screenrecord on the device so
   * it finalizes the file, and kills the adb process. The recording is left on the device.
   */
  dispose(): void {
    const process = this.process;
    if (!process) return;
    this.process = undefined;
    try {
      executeCommand("adb shell pkill -INT screenrecord");
    } catch {
      // The device may be gone already
    }
    process.kill("SIGINT");
  }

  async pullRecording(destinationPath: string): Promise<void> {
    executeCommand(`adb pull ${RECORDING_FOLDER}${this.fileName} ${destinationPath}`);
    executeCommand(`adb shell rm ${RECORDING_FOLDER}${this.fileName}`);
    Logger.info(`Recording saved to ${destinationPath}/${this.fileName}`);
  }
}
