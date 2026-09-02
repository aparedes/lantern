import EventEmitter from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import fs from "fs";
import { expect, jest, spyOn } from "bun:test";

interface MockChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof jest.fn>;
}

const mockSpawn = (): MockChild => {
  const mockProcess = new EventEmitter() as MockChild;
  // readline (see `executeLineProcess`) needs real readable streams
  mockProcess.stdout = new PassThrough();
  mockProcess.stderr = new PassThrough();
  mockProcess.kill = jest.fn();

  return mockProcess;
};

export const aTraceMock = mockSpawn();
export const perfProfilerMock = mockSpawn();

spyOn(require("child_process") as typeof childProcess, "spawn")
  .mockImplementationOnce(((command: string, args: readonly string[]) => {
    expect([command, args]).toEqual(["adb", ["shell", "atrace", "-c", "view", "-t", "999"]]);
    return aTraceMock;
  }) as unknown as typeof childProcess.spawn)
  .mockImplementationOnce(((command: string, args: readonly string[]) => {
    expect([command, args]).toEqual([
      "adb",
      [
        "shell",
        "/data/local/tmp/lantern-android-profiler",
        "pollPerformanceMeasures",
        "com.example",
        "500",
      ],
    ]);
    return perfProfilerMock;
  }) as unknown as typeof childProcess.spawn);

/** readline dispatches "line" events asynchronously: wait a tick after writing to the mocks */
export const flushLines = () => new Promise((resolve) => setTimeout(resolve, 0));

export const MOCK_PID = "123456";

/** What the device binary prints once it found the app's process */
export const emitStarted = () => {
  perfProfilerMock.stdout.write(
    `${JSON.stringify({ type: "status", event: "started", pid: Number(MOCK_PID) })}\n`
  );
};

/** What the device binary prints when the app's process vanished */
export const emitPidChanged = () => {
  perfProfilerMock.stdout.write(
    `${JSON.stringify({
      type: "status",
      event: "pid_changed",
      pid: Number(MOCK_PID),
      detail: `Directory does not exist: /proc/${MOCK_PID}/task`,
    })}\n`
  );
};

/** One NDJSON `measure` line built from the raw /proc and atrace fixtures */
export const emitMeasure = (measureIndex: number) => {
  const cpuOutput: string = fs.readFileSync(
    `${__dirname}/sample-command-output-${measureIndex === 0 ? "1" : "2"}.txt`,
    "utf8"
  );
  const aTraceOutput: string = fs.readFileSync(`${__dirname}/sample-atrace-output.txt`, "utf8");

  perfProfilerMock.stdout.write(
    `${JSON.stringify({
      type: "measure",
      pid: MOCK_PID,
      cpu: cpuOutput.trim(),
      ram: "4430198 96195 58113 3 0 398896 0",
      atrace: aTraceOutput.trim(),
      timestamp: 1651248790047 + measureIndex * 500,
      timings: { totalMs: 42, cpuMs: 20, ramMs: 2, atraceMs: 20 },
    })}\n`
  );
};

export const emitMeasures = () => {
  emitMeasure(0);
  emitMeasure(1);
  emitMeasure(2);
};
