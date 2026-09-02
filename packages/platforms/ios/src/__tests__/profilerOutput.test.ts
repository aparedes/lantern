import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { afterAll, afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger } from "@lantern/logger";
import { DeviceSelectionError } from "@lantern/profiler-protocol";
import { IOSProfiler } from "../index";

interface MockChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock<(signal?: NodeJS.Signals) => boolean>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

// Minimal spawn stand-in: readline needs real streams, the profiler needs close/error events
const UDID = "00008130-000";
const OTHER_UDID = "00008120-111";
/** What the binary's `devices` subcommand reports */
let connectedDevices = [UDID];

const binaryDevice = (udid: string) => ({
  udid,
  productType: "iPhone16,1",
  productVersion: "26.0",
  deviceName: `iPhone ${udid}`,
});

spyOn(childProcess, "execFileSync").mockImplementation(((file: string, args: string[]) => {
  expect(file.endsWith("lantern-ios-profiler")).toBe(true);
  expect(args).toEqual(["devices"]);
  return JSON.stringify(connectedDevices.map(binaryDevice));
}) as unknown as typeof childProcess.execFileSync);

/** Arguments of the last spawned `poll` */
let spawnedArgs: string[] = [];

const mockSpawn = (): MockChild => {
  const child = new EventEmitter() as MockChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  child.exitCode = null;
  child.signalCode = null;

  spyOn(childProcess, "spawn").mockImplementationOnce(((command: string, args: string[]) => {
    expect(command.endsWith("lantern-ios-profiler")).toBe(true);
    expect(args.slice(0, 3)).toEqual(["poll", "--bundle-id", "com.example"]);
    spawnedArgs = args;
    return child;
  }) as unknown as typeof childProcess.spawn);

  return child;
};

// readline dispatches "line" events asynchronously
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("IOSProfiler.startSession", () => {
  const debug = spyOn(Logger, "debug").mockImplementation(() => {});
  const warn = spyOn(Logger, "warn").mockImplementation(() => {});
  const error = spyOn(Logger, "error").mockImplementation(() => {});

  afterEach(() => {
    connectedDevices = [UDID];
    debug.mockClear();
    warn.mockClear();
    error.mockClear();
  });

  it("targets the only connected device, and the requested one when several are", () => {
    mockSpawn();
    new IOSProfiler().startSession("com.example").dispose();
    expect(spawnedArgs).toEqual([
      "poll",
      "--bundle-id",
      "com.example",
      "--interval-ms",
      "500",
      "--udid",
      UDID,
    ]);

    connectedDevices = [OTHER_UDID, UDID];
    mockSpawn();
    new IOSProfiler({ udid: OTHER_UDID }).startSession("com.example").dispose();
    expect(spawnedArgs.slice(-2)).toEqual(["--udid", OTHER_UDID]);
  });

  it("refuses to guess between several devices, and rejects an unknown one", () => {
    connectedDevices = [OTHER_UDID, UDID];

    expect(() => new IOSProfiler().startSession("com.example")).toThrow(
      new DeviceSelectionError(
        `Several iOS devices are connected (${OTHER_UDID}, ${UDID}): pass --device <udid>`
      )
    );
    expect(() => new IOSProfiler({ udid: "nope" }).resolveDevice()).toThrow(
      `Unknown iOS device "nope" (connected: ${OTHER_UDID}, ${UDID})`
    );

    connectedDevices = [];
    expect(() => new IOSProfiler().resolveDevice()).toThrow("No iOS device connected");
    expect(new IOSProfiler().listDevices()).toEqual([]);
  });

  it("deduces the refresh rate from the resolved device's model", () => {
    connectedDevices = [OTHER_UDID, UDID];
    const profiler = new IOSProfiler({ udid: UDID });

    expect(profiler.resolveDevice()).toEqual({
      id: UDID,
      name: `iPhone ${UDID}`,
      platform: "ios",
      model: "iPhone16,1",
    });
    expect(profiler.detectDeviceRefreshRate()).toBe(120);
  });

  afterAll(() => mock.restore());

  it("dispatches measure and status lines and ignores the rest", async () => {
    const child = mockSpawn();
    const onMeasure = jest.fn();
    const onStartMeasuring = jest.fn();

    const session = new IOSProfiler().startSession("com.example");
    session.on("measure", onMeasure);
    session.on("started", onStartMeasuring);

    child.stdout.write(
      [
        '{"type":"status","event":"started","detail":"polling com.example every 500ms"}',
        '{"type":"measure","time":1700000000000,"cpu":{"perName":{"Total":25.5},"perCore":{}},"ram":123.4,"fps":59.9,"threadCount":17,"pid":1234}',
        "garbage",
        '{"event":"target","pid":1234}',
        '{"type":"status","event":"stalled","detail":"no sysmontap sample for 12s"}',
        "",
      ].join("\n")
    );
    await flush();

    expect(onStartMeasuring).toHaveBeenCalledTimes(1);
    expect(onMeasure).toHaveBeenCalledTimes(1);
    expect(onMeasure).toHaveBeenCalledWith({
      cpu: { perName: { Total: 25.5 }, perCore: {} },
      ram: 123.4,
      fps: 59.9,
      time: 1700000000000,
    });
    expect(debug).toHaveBeenCalledWith("Unparseable profiler output: garbage");
    expect(debug).toHaveBeenCalledWith(
      'Unparseable profiler output: {"event":"target","pid":1234}'
    );
    expect(warn).toHaveBeenCalledWith("iOS profiler: stalled (no sysmontap sample for 12s)");
  });

  it("logs stderr markers at the matching level", async () => {
    const child = mockSpawn();
    new IOSProfiler().startSession("com.example");

    child.stderr.write(
      [
        "LANTERN_PROFILER_WARN_TUNNEL_FAILED: CoreDevice tunnel unavailable, trying lockdown fallback",
        "LANTERN_PROFILER_ERROR_STREAM_ENDED: sysmontap: Closed",
        "idevice noise",
        "",
      ].join("\n")
    );
    await flush();

    expect(warn).toHaveBeenCalledWith(
      "LANTERN_PROFILER_WARN_TUNNEL_FAILED: CoreDevice tunnel unavailable, trying lockdown fallback"
    );
    expect(error).toHaveBeenCalledWith("LANTERN_PROFILER_ERROR_STREAM_ENDED: sysmontap: Closed");
    expect(debug).toHaveBeenCalledWith("idevice noise");
  });

  it("reports an unexpected exit through ended and the logger", async () => {
    const child = mockSpawn();
    const onEnd = jest.fn();
    const session = new IOSProfiler().startSession("com.example");
    session.on("ended", onEnd);

    child.emit("close", 1, null);

    expect(onEnd).toHaveBeenCalledWith("lantern-ios-profiler exited unexpectedly (code 1)");
    await expect(session.started).rejects.toThrow("exited unexpectedly (code 1)");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("exited unexpectedly (code 1)");
  });

  it("stop() sends SIGINT, escalates to SIGKILL when the child lingers, and is not an error", () => {
    jest.useFakeTimers();
    try {
      const child = mockSpawn();
      const onEnd = jest.fn();
      const session = new IOSProfiler().startSession("com.example");
      session.on("ended", onEnd);

      const stopping = session.stop();
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
      expect(child.kill).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(3000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      expect(onEnd).toHaveBeenCalledWith("stopped (signal SIGKILL)");
      expect(stopping).resolves.toBeUndefined();
      expect(error).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stop() does not SIGKILL a child that exited in time", () => {
    jest.useFakeTimers();
    try {
      const child = mockSpawn();
      const session = new IOSProfiler().startSession("com.example");

      session.stop();
      child.exitCode = 0;
      child.emit("close", 0, null);
      jest.advanceTimersByTime(3000);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGINT");
    } finally {
      jest.useRealTimers();
    }
  });
});
