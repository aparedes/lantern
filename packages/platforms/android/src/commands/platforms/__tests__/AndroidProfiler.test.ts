import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger, LogLevel } from "@lantern/logger";
import { DeviceSelectionError } from "@lantern/profiler-protocol";
import type { Measure, ProfilingSession } from "@lantern/types";
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
/** What `dumpsys display` reports */
let displayOutput = "fps=60";
const DUMPSYS_DISPLAY = 'shell dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"';

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
    case DUMPSYS_DISPLAY:
      return displayOutput;
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

/** A session spawns its processes once its (async) preparation is over */
const launched = (session: { launched: Promise<void> }) => session.launched.catch(() => {});

const PID = "1234";
/** An idle app: its UI thread (tid = pid) never gets CPU time, nothing is drawn */
const writeRawMeasure = (child: MockChild, timestamp: number) =>
  child.stdout.write(
    `${JSON.stringify({
      type: "measure",
      pid: PID,
      cpu: `${PID} (com.example) S 480 480 0 0 -1 1077952576 6 0 0 0 0 0 40 0 20 0 53 0 233304293 1726836736 45377 18446744073709551615 1 1 0 0 0 0 4612 1 1073775864 0 0 0 -1 5 0 0 0 0 0 0 0 0 0 0 0 0 0`,
      ram: "1000 200 0 0 0 0 0",
      atrace: "",
      timestamp,
      timings: { totalMs: 0, cpuMs: 0, ramMs: 0, atraceMs: 0 },
    })}\n`
  );

/** Lets the readline interfaces deliver what was written to the fake streams */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const collectMeasures = (session: ProfilingSession) => {
  const measures: Measure[] = [];
  session.on("measure", (measure) => measures.push(measure));

  return measures;
};

beforeEach(() => {
  spawned = [];
  connectedDevices = [SERIAL];
  displayOutput = "fps=60";
  error.mockClear();
  execFileSync.mockClear();
});
afterAll(() => mock.restore());

describe("AndroidProfiler", () => {
  describe("device resolution", () => {
    it("uses the only connected device and targets every adb call at it", async () => {
      const profiler = new AndroidProfiler();

      expect(await profiler.resolveDevice()).toEqual({
        id: SERIAL,
        name: "Pixel 7",
        platform: "android",
      });
      await profiler.installProfilerOnDevice();

      expect(adbCalls()).toContain(`-s ${SERIAL} shell getprop ro.build.version.sdk`);
      expect(adbCalls()).toContain(`-s ${SERIAL} shell chmod 755 ${PROFILER_PATH}`);
    });

    it("installs the profiler once, sharing the installation between callers", async () => {
      const profiler = new AndroidProfiler();

      await Promise.all([profiler.installProfilerOnDevice(), profiler.installProfilerOnDevice()]);
      await profiler.installProfilerOnDevice();

      expect(adbCalls().filter((call) => call.includes("chmod 755"))).toHaveLength(1);
    });

    it("uses the requested device", async () => {
      connectedDevices = [OTHER_SERIAL, SERIAL];

      expect((await new AndroidProfiler({ serial: SERIAL }).resolveDevice()).id).toBe(SERIAL);
    });

    it("refuses to guess between several devices", async () => {
      connectedDevices = [OTHER_SERIAL, SERIAL];

      await expect(new AndroidProfiler().resolveDevice()).rejects.toThrow(
        new DeviceSelectionError(
          `Several Android devices are connected (${OTHER_SERIAL}, ${SERIAL}): pass --device <serial>`
        )
      );
    });

    it("rejects an unknown requested device and reports when none is connected", async () => {
      await expect(new AndroidProfiler({ serial: "nope" }).resolveDevice()).rejects.toThrow(
        `Unknown Android device "nope" (connected: ${SERIAL})`
      );

      connectedDevices = [];
      const session = new AndroidProfiler().startSession("com.example");
      await expect(session.launched).rejects.toThrow("No Android device connected");
      expect(await session.ended).toBe("No Android device connected");
      expect(spawned).toHaveLength(0);
    });

    it("retries the device resolution once a device is connected", async () => {
      connectedDevices = [];
      const profiler = new AndroidProfiler();
      await expect(profiler.resolveDevice()).rejects.toThrow("No Android device connected");

      connectedDevices = [SERIAL];
      expect((await profiler.resolveDevice()).id).toBe(SERIAL);
    });

    it("lists devices without needing one", async () => {
      connectedDevices = [];

      expect(await new AndroidProfiler().listDevices()).toEqual([]);
    });
  });

  describe("atrace", () => {
    it("restarts atrace when its tracing budget expires", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);
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

    it("does not restart atrace when it failed, and never throws from the close handler", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);

      // e.g. the device got disconnected
      expect(() => atraceProcesses()[0].child.emit("close", 1, null)).not.toThrow();

      expect(atraceProcesses()).toHaveLength(1);
      // `executeAsync` also logs the unexpected exit code itself
      expect(loggedErrors()).toContainEqual(expect.stringContaining("atrace exited with code 1"));
      session.dispose();
    });

    it("does not restart atrace once stopped, and leaves the device's tracing off", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);
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

    it("is not started when profiling the profiler itself", async () => {
      const profiler = new AndroidProfiler({ selfProfiling: true });
      const session = profiler.startSession(await profiler.detectCurrentBundleId());
      await launched(session);

      expect(await profiler.detectCurrentBundleId()).toBe("lantern-android-profiler");
      expect(profiler.supportFPS()).toBe(false);
      expect(await profiler.detectDeviceRefreshRate()).toBe(60);
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

  describe("FPS", () => {
    it("targets the refresh rate of the profiler's own device", async () => {
      displayOutput = "fps=120";
      const highRefresh = new AndroidProfiler();
      expect(await highRefresh.detectDeviceRefreshRate()).toBe(120);

      displayOutput = "fps=60";
      const lowRefresh = new AndroidProfiler();
      expect(await lowRefresh.detectDeviceRefreshRate()).toBe(60);
      // Each profiler detected it once, and keeps its own
      expect(await highRefresh.detectDeviceRefreshRate()).toBe(120);
      expect(adbCalls().filter((call) => call.endsWith(DUMPSYS_DISPLAY))).toHaveLength(2);

      // An idle app scores the full refresh rate of its device
      const session = highRefresh.startSession("com.example");
      await launched(session);
      const measures = collectMeasures(session);
      const { child } = profilerProcess()!;
      writeRawMeasure(child, 1000);
      writeRawMeasure(child, 1500);
      await tick();

      expect(measures.map(({ fps }) => fps)).toEqual([120]);
      session.dispose();
    });

    it("stops reporting FPS once the profiler reports that atrace is unavailable", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);
      const measures = collectMeasures(session);
      const { child } = profilerProcess()!;

      writeRawMeasure(child, 1000);
      writeRawMeasure(child, 1500);
      await tick();
      expect(measures).toHaveLength(1);
      expect(measures[0].fps).toBe(60);

      // stdout and stderr are read independently: the marker is read before the next measures
      child.stderr.write(
        "LANTERN_PROFILER_WARN_ATRACE_UNAVAILABLE: Unable to find Atrace output file\n"
      );
      await tick();
      writeRawMeasure(child, 2000);
      writeRawMeasure(child, 2500);
      await tick();

      expect(measures).toHaveLength(3);
      expect(measures.slice(1).map((measure) => "fps" in measure)).toEqual([false, false]);
      expect(measures.slice(1).map(({ time }) => time)).toEqual([1000, 1500]);
      session.dispose();
    });

    it("stops reporting FPS once atrace failed", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);
      const measures = collectMeasures(session);
      const { child } = profilerProcess()!;

      writeRawMeasure(child, 1000);
      writeRawMeasure(child, 1500);
      await tick();
      expect(measures[0].fps).toBe(60);

      atraceProcesses()[0].child.emit("close", 1, null);
      writeRawMeasure(child, 2000);
      await tick();

      expect(measures).toHaveLength(2);
      expect("fps" in measures[1]).toBe(false);
      session.dispose();
    });
  });

  describe("startSession", () => {
    it("spawns the profiler on the resolved device", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);

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
      await launched(session);
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
      await launched(session);

      const stopping = session.stop();
      const { child } = profilerProcess()!;
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
      child.emit("close", null, "SIGINT");

      await stopping;
      expect(await session.ended).toBe("stopped (signal SIGINT)");
      expect(error).not.toHaveBeenCalled();
    });

    it("dispose() kills the profiler and atrace right away and stops the device's tracing", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      await launched(session);

      session.dispose();
      session.dispose();

      expect(profilerProcess()!.child.kill).toHaveBeenCalledWith("SIGINT");
      expect(atraceProcesses()[0].child.kill).toHaveBeenCalledTimes(1);
      expect(atraceStopCalls()).toBe(2);
    });

    it("dispose() before the preparation is over spawns nothing", async () => {
      const session = new AndroidProfiler().startSession("com.example");
      session.dispose();
      await launched(session);

      expect(spawned).toHaveLength(0);
      expect(await session.ended).toBe("disposed before the profiler started");
    });
  });
});
