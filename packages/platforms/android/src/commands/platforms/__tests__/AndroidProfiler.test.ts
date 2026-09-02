import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { AndroidProfiler } from "../AndroidProfiler";
import { LanternSelfProfiler } from "../LanternSelfProfiler";

Logger.setLogLevel(LogLevel.SILENT);

interface MockChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof jest.fn>;
}

const mockChild = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  // readline needs real readable streams
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
};

/** Every spawned process, in order: atrace first, then the profiler (see `AndroidProfilingSession.launch`) */
let spawned: { command: string; args: readonly string[]; child: MockChild }[] = [];

spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[]) => {
  const child = mockChild();
  spawned.push({ command, args, child });
  return child;
}) as unknown as typeof childProcess.spawn);

const execSync = spyOn(childProcess, "execSync").mockImplementation(((command: string) => ({
  toString: () => {
    switch (command) {
      case "adb shell getprop ro.build.version.sdk":
        return "30";
      case "adb shell getprop ro.product.cpu.abi":
        return "arm64-v8a";
      case "adb shell /data/local/tmp/lantern-android-profiler printCpuClockTick":
      case "adb shell /data/local/tmp/lantern-android-profiler_SELF_REPORT printCpuClockTick":
        return "100";
      case "adb shell /data/local/tmp/lantern-android-profiler printRAMPageSize":
      case "adb shell /data/local/tmp/lantern-android-profiler_SELF_REPORT printRAMPageSize":
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
const atraceStopCalls = () =>
  execSync.mock.calls.filter(([command]) => command === "adb shell atrace --async_stop").length;

const atraceProcesses = () => spawned.filter(({ args }) => args.includes("atrace"));
const profilerProcess = () => spawned.find(({ args }) => args.includes("pollPerformanceMeasures"));

beforeEach(() => {
  spawned = [];
  error.mockClear();
  execSync.mockClear();
});
afterAll(() => mock.restore());

describe("AndroidProfiler", () => {
  describe("atrace", () => {
    it("restarts atrace when its tracing budget expires", () => {
      const session = new AndroidProfiler().startSession("com.example");
      expect(atraceProcesses()).toHaveLength(1);

      atraceProcesses()[0].child.emit("close", 0, null);

      expect(atraceProcesses()).toHaveLength(2);
      expect(error).not.toHaveBeenCalled();
      session.dispose();
    });

    it("does not restart atrace when it failed, and never throws from the close handler", () => {
      const session = new AndroidProfiler().startSession("com.example");

      // e.g. the device got disconnected
      expect(() => atraceProcesses()[0].child.emit("close", 1, null)).not.toThrow();

      expect(atraceProcesses()).toHaveLength(1);
      // `executeAsync` also logs the unexpected exit code itself
      expect(loggedErrors()).toContainEqual(expect.stringContaining("atrace exited with code 1"));
      session.dispose();
    });

    it("does not restart atrace once stopped, and leaves the device's tracing off", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      // Started once, flushing whatever a previous run left behind
      expect(atraceStopCalls()).toBe(1);

      const stopping = session.stop();
      profilerProcess()!.child.emit("close", null, "SIGINT");
      await stopping;

      const [{ child }] = atraceProcesses();
      expect(child.kill).toHaveBeenCalled();
      child.emit("close", null, "SIGTERM");

      expect(atraceProcesses()).toHaveLength(1);
      expect(atraceStopCalls()).toBe(2);
    });

    it("is not started when profiling the profiler itself", () => {
      const session = new LanternSelfProfiler().startSession("lantern-android-profiler");

      expect(atraceProcesses()).toHaveLength(0);
      expect(profilerProcess()).toBeDefined();
      session.dispose();
      expect(atraceStopCalls()).toBe(0);
    });
  });

  describe("startSession", () => {
    it("reports an unexpected profiler exit through ended and the logger", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      const ended = jest.fn();
      session.on("ended", ended);

      profilerProcess()?.child.emit("close", 1, null);

      expect(ended).toHaveBeenCalledWith("lantern-android-profiler exited unexpectedly (code 1)");
      expect(await session.ended).toBe("lantern-android-profiler exited unexpectedly (code 1)");
      await expect(session.started).rejects.toThrow("exited unexpectedly (code 1)");
      expect(loggedErrors()).toContainEqual(
        expect.stringContaining("exited unexpectedly (code 1)")
      );
    });

    it("reports the exit after stop() as expected", async () => {
      const session = new AndroidProfiler().startSession("com.example");

      const stopping = session.stop();
      const { child } = profilerProcess()!;
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
      child.emit("close", null, "SIGINT");

      await stopping;
      expect(await session.ended).toBe("stopped (signal SIGINT)");
      expect(error).not.toHaveBeenCalled();
    });

    it("dispose() kills the profiler and atrace right away and stops the device's tracing", () => {
      const session = new AndroidProfiler().startSession("com.example");

      session.dispose();
      session.dispose();

      expect(profilerProcess()!.child.kill).toHaveBeenCalledWith("SIGINT");
      expect(atraceProcesses()[0].child.kill).toHaveBeenCalledTimes(1);
      expect(atraceStopCalls()).toBe(2);
    });
  });
});
