import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger } from "@lantern/logger";
import { DeviceSelectionError, ServeRequestError } from "@lantern/profiler-protocol";
import { IOSProfiler, toDeviceInfos } from "../index";
import {
  FakeServeChild,
  currentChild,
  flush,
  mockServeSpawn,
  nthRequest,
  spawnedChildren,
} from "./fakeServeChild";

mockServeSpawn();

const UDID = "00008130-000";
const OTHER_UDID = "00008120-111";

const binaryDevice = (udid: string, connectionType = "Usb") => ({
  udid,
  connectionType,
  productType: "iPhone16,1",
  productVersion: "26.0",
  deviceName: `iPhone ${udid}`,
});

const debug = spyOn(Logger, "debug").mockImplementation(() => {});
const warn = spyOn(Logger, "warn").mockImplementation(() => {});
const error = spyOn(Logger, "error").mockImplementation(() => {});

beforeEach(() => {
  spawnedChildren.length = 0;
});
afterEach(() => {
  debug.mockClear();
  warn.mockClear();
  error.mockClear();
});
afterAll(() => mock.restore());

/** Answers the child's next `devices` request with `udids`. */
const answerDevices = async (child: FakeServeChild, udids: string[], n = 1) => {
  const request = await nthRequest(child, n);
  expect(request.cmd).toBe("devices");
  child.respond(
    request.id,
    udids.map((udid) => binaryDevice(udid))
  );
};

describe("toDeviceInfos", () => {
  it("lists a device once, described from its USB entry", () => {
    expect(
      toDeviceInfos([
        { ...binaryDevice(UDID, "Network(fe80::1)"), deviceName: null },
        binaryDevice(UDID),
        binaryDevice(OTHER_UDID, "Network(fe80::2)"),
      ])
    ).toEqual([
      { id: UDID, name: `iPhone ${UDID}`, platform: "ios", model: "iPhone16,1" },
      { id: OTHER_UDID, name: `iPhone ${OTHER_UDID}`, platform: "ios", model: "iPhone16,1" },
    ]);
  });
});

describe("IOSProfiler devices", () => {
  it("lists devices through the serve child, and never throws", async () => {
    const profiler = new IOSProfiler();
    const listing = profiler.listDevices();
    const child = await currentChild();
    expect(child.args).toEqual(["serve"]);
    await answerDevices(child, [UDID]);

    expect(await listing).toEqual([
      { id: UDID, name: `iPhone ${UDID}`, platform: "ios", model: "iPhone16,1" },
    ]);

    const failing = profiler.listDevices();
    const request = await nthRequest(child, 2);
    child.fail(request.id, "NO_DEVICE", "usbmuxd: not running");
    expect(await failing).toEqual([]);
    expect(debug).toHaveBeenCalledWith("lantern-ios-profiler devices failed: usbmuxd: not running");
  });

  it("resolves the only connected device once, and the requested one when several are", async () => {
    const profiler = new IOSProfiler();
    const resolving = profiler.resolveDevice();
    await answerDevices(await currentChild(), [UDID]);
    expect((await resolving).id).toBe(UDID);
    expect((await profiler.resolveDevice()).id).toBe(UDID);
    expect(spawnedChildren[0].requests).toHaveLength(1);

    const picky = new IOSProfiler({ udid: OTHER_UDID });
    const pickyResolving = picky.resolveDevice();
    const child = spawnedChildren[1] ?? (await currentChild());
    expect(child.args).toEqual(["serve", "--udid", OTHER_UDID]);
    await answerDevices(child, [UDID, OTHER_UDID]);
    expect((await pickyResolving).id).toBe(OTHER_UDID);
  });

  it("refuses to guess between several devices, rejects an unknown one, and retries later", async () => {
    const profiler = new IOSProfiler();
    const ambiguous = profiler.resolveDevice();
    const child = await currentChild();
    await answerDevices(child, [OTHER_UDID, UDID]);
    await expect(ambiguous).rejects.toThrow(
      new DeviceSelectionError(
        `Several iOS devices are connected (${OTHER_UDID}, ${UDID}): pass --device <udid>`
      )
    );

    const none = profiler.resolveDevice();
    await answerDevices(child, [], 2);
    await expect(none).rejects.toThrow("No iOS device connected");

    const later = profiler.resolveDevice();
    await answerDevices(child, [UDID], 3);
    expect((await later).id).toBe(UDID);

    const unknown = new IOSProfiler({ udid: "nope" }).resolveDevice();
    await answerDevices(spawnedChildren[1], [UDID]);
    await expect(unknown).rejects.toThrow(`Unknown iOS device "nope" (connected: ${UDID})`);
  });

  it("deduces the refresh rate from the resolved device's model", async () => {
    const profiler = new IOSProfiler();
    const rate = profiler.detectDeviceRefreshRate();
    await answerDevices(await currentChild(), [UDID]);

    expect(await rate).toBe(120);
  });

  it("dispose() ends the serve child", async () => {
    const profiler = new IOSProfiler();
    profiler.listDevices();
    const child = await currentChild();

    profiler.dispose();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
  });
});

describe("IOSProfiler apps", () => {
  it("lists apps with their running state over the same child", async () => {
    const profiler = new IOSProfiler();
    const listing = profiler.listApps();
    const child = await currentChild();
    await answerDevices(child, [UDID]);

    const apps = await nthRequest(child, 2);
    expect(apps.cmd).toBe("apps");
    child.respond(apps.id, [
      { bundleId: "com.example.b", name: "Beta", executableName: "Beta", kind: "User" },
      { bundleId: "com.example.a", name: "Alpha", executableName: "Alpha", kind: "User" },
    ]);
    const running = await nthRequest(child, 3);
    expect(running.cmd).toBe("running-apps");
    child.respond(running.id, [
      { bundleId: "com.example.b", name: "Beta", executableName: "Beta", kind: "User", pid: 4 },
    ]);

    expect(await listing).toEqual([
      { bundleId: "com.example.b", name: "Beta", isRunning: true },
      { bundleId: "com.example.a", name: "Alpha", isRunning: false },
    ]);
  });

  it("detects the only running app, and asks to pick otherwise", async () => {
    const profiler = new IOSProfiler();
    const detecting = profiler.detectCurrentBundleId();
    const child = await currentChild();
    await answerDevices(child, [UDID]);
    const running = await nthRequest(child, 2);
    expect(running.cmd).toBe("running-apps");
    child.respond(running.id, [
      { bundleId: "com.example.a", name: "Alpha", executableName: "Alpha", kind: "User", pid: 4 },
    ]);
    expect(await detecting).toBe("com.example.a");

    const none = profiler.detectCurrentBundleId();
    child.respond((await nthRequest(child, 3)).id, []);
    await expect(none).rejects.toThrow("No app is running on the iOS device");
  });

  it("stops an app with a kill request, and only logs a failure", async () => {
    const profiler = new IOSProfiler();
    const stopping = profiler.stopApp("com.example.a");
    const child = await currentChild();
    await answerDevices(child, [UDID]);
    const kill = await nthRequest(child, 2);
    expect(kill).toEqual({ id: 2, cmd: "kill", bundleId: "com.example.a" });
    child.fail(kill.id, "APP_NOT_FOUND", "com.example.a is not running");

    await stopping;
    expect(debug).toHaveBeenCalledWith(
      "Could not stop com.example.a: com.example.a is not running"
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe("IOSProfiler.startSession", () => {
  /** A session whose poll request was accepted by the child */
  const startPolling = async (profiler = new IOSProfiler()) => {
    const session = profiler.startSession("com.example");
    const child = await currentChild();
    await answerDevices(child, [UDID]);
    const poll = await nthRequest(child, 2);
    expect(poll).toEqual({
      id: 2,
      cmd: "poll",
      bundleId: "com.example",
      intervalMs: 500,
      fps: true,
    });
    child.respond(poll.id, { polling: true });
    await session.launched;
    return { session, child };
  };

  it("streams measures and status lines into the session", async () => {
    const { session, child } = await startPolling();
    const onMeasure = jest.fn();
    const onStarted = jest.fn();
    session.on("measure", onMeasure);
    session.on("started", onStarted);

    child.stdout.write(
      [
        '{"type":"status","event":"started","detail":"polling com.example every 500ms"}',
        '{"type":"measure","time":1700000000000,"cpu":{"perName":{"Total":25.5},"perCore":{}},"ram":123.4,"fps":59.9,"threadCount":17,"pid":1234}',
        "garbage",
        '{"type":"status","event":"stalled","detail":"no sysmontap sample for 12s"}',
        "",
      ].join("\n")
    );
    await session.started;
    await flush();

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onMeasure).toHaveBeenCalledWith({
      cpu: { perName: { Total: 25.5 }, perCore: {} },
      ram: 123.4,
      fps: 59.9,
      time: 1700000000000,
    });
    expect(debug).toHaveBeenCalledWith("Unparseable profiler output: garbage");
    expect(warn).toHaveBeenCalledWith("iOS profiler: stalled (no sysmontap sample for 12s)");
    session.dispose();
  });

  it("stop() asks the child to stop and ends once the taps are down, without an error", async () => {
    const { session, child } = await startPolling();
    const ended = jest.fn();
    session.on("ended", ended);

    const stopping = session.stop();
    const stop = await nthRequest(child, 3);
    expect(stop).toEqual({ id: 3, cmd: "stop" });
    child.stream({ type: "status", event: "stopped" });
    child.respond(stop.id, { stopped: true });
    await stopping;

    expect(ended).toHaveBeenCalledWith("stopped");
    expect(error).not.toHaveBeenCalled();
    // The child outlives the session
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("ends with an error when the stream dies on its own", async () => {
    const { session, child } = await startPolling();
    const ended = jest.fn();
    session.on("ended", ended);

    child.stream({ type: "status", event: "ended", detail: "sysmontap: Closed" });
    await session.ended;

    expect(ended).toHaveBeenCalledWith("the profiler stream ended (sysmontap: Closed)");
    await expect(session.started).rejects.toThrow("the profiler stream ended");
    expect(error).toHaveBeenCalledWith(
      "the profiler stream ended (sysmontap: Closed): no more measures will be collected"
    );
    // A later stop() is a no-op for the binary
    await session.stop();
    expect(child.requests).toHaveLength(2);
  });

  it("ends when the serve child dies, and the next session respawns it", async () => {
    const profiler = new IOSProfiler();
    const { session, child } = await startPolling(profiler);

    child.exitCode = 1;
    child.emit("close", 1, null);

    expect(await session.ended).toBe("lantern-ios-profiler exited unexpectedly (code 1)");

    const next = profiler.startSession("com.example");
    await nthRequest(spawnedChildren[1] ?? (await currentChild()), 1);
    expect(spawnedChildren).toHaveLength(2);
    next.dispose();
  });

  it("surfaces a BUSY reply to a request made while polling", async () => {
    const profiler = new IOSProfiler();
    const { session, child } = await startPolling(profiler);

    const listing = profiler.listApps();
    const apps = await nthRequest(child, 3);
    child.fail(apps.id, "BUSY", "a poll is running: send stop first");

    const rejection = await listing.catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ServeRequestError);
    expect((rejection as ServeRequestError).code).toBe("BUSY");
    session.dispose();
  });

  it("fails the session when the poll request is refused", async () => {
    const session = new IOSProfiler().startSession("com.example");
    const child = await currentChild();
    await answerDevices(child, [UDID]);
    const poll = await nthRequest(child, 2);
    child.fail(poll.id, "APP_NOT_FOUND", "com.example is not installed");

    await expect(session.launched).rejects.toThrow("com.example is not installed");
    expect(await session.ended).toBe("com.example is not installed");
  });

  it("dispose() sends stop without waiting, and the session ends on the stopped status", async () => {
    const { session, child } = await startPolling();

    session.dispose();
    const stop = await nthRequest(child, 3);
    expect(stop.cmd).toBe("stop");
    child.stream({ type: "status", event: "stopped" });
    child.respond(stop.id, { stopped: true });

    expect(await session.ended).toBe("stopped");
    expect(error).not.toHaveBeenCalled();
  });

  it("dispose() before the device is resolved spawns no poll", async () => {
    const profiler = new IOSProfiler();
    const session = profiler.startSession("com.example");
    session.dispose();
    const child = await currentChild();
    await answerDevices(child, [UDID]);

    expect(await session.ended).toBe("disposed before the profiler started");
    await flush();
    expect(child.requests.map((request) => request.cmd)).not.toContain("poll");
  });

  it("warns that recording is not supported", async () => {
    const session = new IOSProfiler().startSession("com.example", {
      recording: { videoPath: "/tmp/video.mp4" },
    });
    expect(warn).toHaveBeenCalledWith(
      "Screen recording is not supported on iOS, no video will be recorded"
    );
    session.dispose();
  });
});
