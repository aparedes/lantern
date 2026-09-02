import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { AndroidProfiler } from "../AndroidProfiler";

Logger.setLogLevel(LogLevel.SILENT);

interface MockChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof jest.fn>;
}

const mockChild = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  // readline (see `executeLineProcess`) needs real readable streams
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
};

/** Every spawned process, in order: atrace first, then the profiler (see `installProfilerOnDevice`) */
let spawned: { command: string; args: readonly string[]; child: MockChild }[] = [];

spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[]) => {
  const child = mockChild();
  spawned.push({ command, args, child });
  return child;
}) as unknown as typeof childProcess.spawn);

spyOn(childProcess, "execSync").mockImplementation(((command: string) => ({
  toString: () => {
    switch (command) {
      case "adb shell getprop ro.build.version.sdk":
        return "30";
      case "adb shell getprop ro.product.cpu.abi":
        return "arm64-v8a";
      case "adb shell /data/local/tmp/lantern-android-profiler printCpuClockTick":
        return "100";
      case "adb shell /data/local/tmp/lantern-android-profiler printRAMPageSize":
        return "4096";
      case 'adb shell dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"':
        return "fps=60";
      default:
        return "";
    }
  },
})) as unknown as typeof childProcess.execSync);

const error = spyOn(Logger, "error");
const loggedErrors = () => error.mock.calls.map(([message]) => message);

const atraceProcesses = () => spawned.filter(({ args }) => args.includes("atrace"));
const profilerProcess = () => spawned.find(({ args }) => args.includes("pollPerformanceMeasures"));

beforeEach(() => {
  spawned = [];
  error.mockClear();
});
afterAll(() => mock.restore());

describe("AndroidProfiler", () => {
  describe("atrace", () => {
    it("restarts atrace when its tracing budget expires", () => {
      const profiler = new AndroidProfiler();
      profiler.installProfilerOnDevice();
      expect(atraceProcesses()).toHaveLength(1);

      atraceProcesses()[0].child.emit("close", 0, null);

      expect(atraceProcesses()).toHaveLength(2);
      expect(error).not.toHaveBeenCalled();
    });

    it("does not restart atrace when it failed, and never throws from the close handler", () => {
      const profiler = new AndroidProfiler();
      profiler.installProfilerOnDevice();

      // e.g. the device got disconnected
      expect(() => atraceProcesses()[0].child.emit("close", 1, null)).not.toThrow();

      expect(atraceProcesses()).toHaveLength(1);
      // `executeAsync` also logs the unexpected exit code itself
      expect(loggedErrors()).toContainEqual(expect.stringContaining("atrace exited with code 1"));
    });

    it("does not restart atrace once stopped", () => {
      const profiler = new AndroidProfiler();
      profiler.installProfilerOnDevice();
      profiler.stop();

      const [{ child }] = atraceProcesses();
      expect(child.kill).toHaveBeenCalled();
      child.emit("close", null, "SIGTERM");

      expect(atraceProcesses()).toHaveLength(1);
    });
  });

  describe("pollPerformanceMeasures", () => {
    it("reports an unexpected profiler exit through onEnd and the logger", () => {
      const onEnd = jest.fn();
      new AndroidProfiler().pollPerformanceMeasures("com.example", { onMeasure: jest.fn(), onEnd });

      profilerProcess()?.child.emit("close", 1, null);

      expect(onEnd).toHaveBeenCalledWith("lantern-android-profiler exited unexpectedly (code 1)");
      expect(loggedErrors()).toContainEqual(
        expect.stringContaining("exited unexpectedly (code 1)")
      );
    });

    it("reports the exit after stop() as expected", () => {
      const onEnd = jest.fn();
      const { stop } = new AndroidProfiler().pollPerformanceMeasures("com.example", {
        onMeasure: jest.fn(),
        onEnd,
      });

      stop();
      const { child } = profilerProcess()!;
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
      child.emit("close", null, "SIGINT");

      expect(onEnd).toHaveBeenCalledWith("stopped (signal SIGINT)");
      expect(error).not.toHaveBeenCalled();
    });
  });
});
