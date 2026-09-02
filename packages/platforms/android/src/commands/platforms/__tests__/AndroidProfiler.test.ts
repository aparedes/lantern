import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { DeviceSelectionError } from "@lantern/profiler-protocol";
import { AndroidProfiler } from "../AndroidProfiler";

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

const SERIAL = "R58M12345Z";
const OTHER_SERIAL = "emulator-5554";
const PROFILER_PATH = "/data/local/tmp/lantern-android-profiler";

/** Every spawned process, in order: atrace first, then the profiler (see `AndroidProfilingSession.launch`) */
let spawned: { command: string; args: readonly string[]; child: MockChild }[] = [];
/** What `adb devices -l` reports */
let connectedDevices = [SERIAL];

spyOn(childProcess, "spawn").mockImplementation(((command: string, args: readonly string[]) => {
  const child = mockChild();
  spawned.push({ command, args, child });
  return child;
}) as unknown as typeof childProcess.spawn);

const execFileSync = spyOn(childProcess, "execFileSync").mockImplementation(((
  file: string,
  args: readonly string[]
) => {
  expect(file).toBe("adb");
  if (args[0] === "devices") {
    return `List of devices attached\n${connectedDevices.map((serial) => `${serial} device model:Pixel_7`).join("\n")}\n`;
  }
  // Everything else targets the resolved device
  expect(args.slice(0, 2)).toEqual(["-s", SERIAL]);
  switch (args.slice(2).join(" ")) {
    case "shell getprop ro.build.version.sdk":
      return "30";
    case "shell getprop ro.product.cpu.abi":
      return "arm64-v8a";
    case `shell ${PROFILER_PATH} printCpuClockTick`:
    case `shell ${PROFILER_PATH}_SELF_REPORT printCpuClockTick`:
      return "100";
    case `shell ${PROFILER_PATH} printRAMPageSize`:
    case `shell ${PROFILER_PATH}_SELF_REPORT printRAMPageSize`:
      return "4096";
    case 'shell dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"':
      return "fps=60";
    default:
      return "";
  }
}) as unknown as typeof childProcess.execFileSync);

const error = spyOn(Logger, "error");
const loggedErrors = () => error.mock.calls.map(([message]) => message);
const adbCalls = () => execFileSync.mock.calls.map(([, args]) => (args as string[]).join(" "));
const atraceStopCalls = () =>
  adbCalls().filter((call) => call.endsWith("shell atrace --async_stop")).length;

const atraceProcesses = () => spawned.filter(({ args }) => args.includes("atrace"));
const profilerProcess = () => spawned.find(({ args }) => args.includes("pollPerformanceMeasures"));

beforeEach(() => {
  spawned = [];
  connectedDevices = [SERIAL];
  error.mockClear();
  execFileSync.mockClear();
});
afterAll(() => mock.restore());

describe("AndroidProfiler", () => {
  describe("device resolution", () => {
    it("uses the only connected device and targets every adb call at it", () => {
      const profiler = new AndroidProfiler();

      expect(profiler.resolveDevice()).toEqual({
        id: SERIAL,
        name: "Pixel 7",
        platform: "android",
      });
      profiler.installProfilerOnDevice();

      expect(adbCalls()).toContain(`-s ${SERIAL} shell getprop ro.build.version.sdk`);
      expect(adbCalls()).toContain(`-s ${SERIAL} shell chmod 755 ${PROFILER_PATH}`);
    });

    it("uses the requested device", () => {
      connectedDevices = [OTHER_SERIAL, SERIAL];

      expect(new AndroidProfiler({ serial: SERIAL }).resolveDevice().id).toBe(SERIAL);
    });

    it("refuses to guess between several devices", () => {
      connectedDevices = [OTHER_SERIAL, SERIAL];

      expect(() => new AndroidProfiler().resolveDevice()).toThrow(
        new DeviceSelectionError(
          `Several Android devices are connected (${OTHER_SERIAL}, ${SERIAL}): pass --device <serial>`
        )
      );
    });

    it("rejects an unknown requested device and reports when none is connected", () => {
      expect(() => new AndroidProfiler({ serial: "nope" }).resolveDevice()).toThrow(
        `Unknown Android device "nope" (connected: ${SERIAL})`
      );

      connectedDevices = [];
      expect(() => new AndroidProfiler().startSession("com.example")).toThrow(
        "No Android device connected"
      );
      expect(spawned).toHaveLength(0);
    });

    it("lists devices without needing one", () => {
      connectedDevices = [];

      expect(new AndroidProfiler().listDevices()).toEqual([]);
    });
  });

  describe("atrace", () => {
    it("restarts atrace when its tracing budget expires", () => {
      const session = new AndroidProfiler().startSession("com.example");
      expect(atraceProcesses()).toHaveLength(1);
      expect(atraceProcesses()[0].args).toEqual([
        "-s",
        SERIAL,
        "shell",
        "atrace",
        "-c",
        "view",
        "-t",
        "999",
      ]);

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
      const profiler = new AndroidProfiler({ selfProfiling: true });
      const session = profiler.startSession(profiler.detectCurrentBundleId());

      expect(profiler.detectCurrentBundleId()).toBe("lantern-android-profiler");
      expect(profiler.supportFPS()).toBe(false);
      expect(profiler.detectDeviceRefreshRate()).toBe(60);
      expect(atraceProcesses()).toHaveLength(0);
      expect(profilerProcess()!.args).toEqual([
        "-s",
        SERIAL,
        "shell",
        `${PROFILER_PATH}_SELF_REPORT`,
        "pollPerformanceMeasures",
        "lantern-android-profiler",
        "500",
      ]);
      session.dispose();
      expect(atraceStopCalls()).toBe(0);
    });
  });

  describe("startSession", () => {
    it("spawns the profiler on the resolved device", () => {
      const session = new AndroidProfiler().startSession("com.example");

      expect(profilerProcess()!.args).toEqual([
        "-s",
        SERIAL,
        "shell",
        PROFILER_PATH,
        "pollPerformanceMeasures",
        "com.example",
        "500",
      ]);
      session.dispose();
    });

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
