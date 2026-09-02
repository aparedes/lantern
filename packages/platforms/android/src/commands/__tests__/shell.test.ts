import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { test, expect, afterAll, jest, spyOn, mock } from "bun:test";
import { executeLineProcess } from "../shell";

// readline needs a real readable stream, and dispatches "line" events asynchronously
const mockSpawn = (): { stdout: PassThrough } => {
  const mockProcess = new EventEmitter();
  // @ts-expect-error
  mockProcess.stdout = new PassThrough();

  spyOn(childProcess, "spawn").mockImplementationOnce(((
    command: string,
    args: readonly string[]
  ) => {
    expect([command, args]).toEqual([
      "adb",
      ["shell", "/data/local/tmp/lantern-android-profiler", "pollPerformanceMeasures", "PID_ID"],
    ]);
    return mockProcess;
  }) as unknown as typeof childProcess.spawn);

  // @ts-expect-error
  return mockProcess;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("executeLineProcess delivers complete lines whatever the chunking", async () => {
  const onLine = jest.fn();
  const mockProcess = mockSpawn();

  executeLineProcess(
    "adb shell /data/local/tmp/lantern-android-profiler pollPerformanceMeasures PID_ID",
    onLine
  );

  mockProcess.stdout.write('{"type":"status","event":"started"}\n{"type":"measure","pid":"1"');
  await flush();
  // The second line is not complete yet
  expect(onLine).toHaveBeenCalledTimes(1);
  expect(onLine).toHaveBeenNthCalledWith(1, '{"type":"status","event":"started"}');

  mockProcess.stdout.write(',"cpu":"a"}\r\n');
  mockProcess.stdout.write('{"type":"status","event":"stalled"}\n{"type":"status"');
  await flush();
  expect(onLine).toHaveBeenCalledTimes(3);
  expect(onLine).toHaveBeenNthCalledWith(2, '{"type":"measure","pid":"1","cpu":"a"}');
  expect(onLine).toHaveBeenNthCalledWith(3, '{"type":"status","event":"stalled"}');

  // A trailing partial line is delivered when stdout ends
  mockProcess.stdout.write(',"event":"end"}');
  mockProcess.stdout.end();
  await flush();
  expect(onLine).toHaveBeenCalledTimes(4);
  expect(onLine).toHaveBeenNthCalledWith(4, '{"type":"status","event":"end"}');
});

test("executeLineProcess skips nothing, even empty lines", async () => {
  const onLine = jest.fn();
  const mockProcess = mockSpawn();

  executeLineProcess(
    "adb shell /data/local/tmp/lantern-android-profiler pollPerformanceMeasures PID_ID",
    onLine
  );

  mockProcess.stdout.write("a\n\nb\n");
  await flush();

  expect(onLine.mock.calls).toEqual([["a"], [""], ["b"]]);
});

afterAll(() => mock.restore());
