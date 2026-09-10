import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { Logger } from "@lantern/logger";
import { ServeRequestError } from "@lantern/profiler-protocol";
import { FIRST_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, ServeClient } from "../serveClient";
import {
  currentChild,
  flush,
  mockServeSpawn,
  nthRequest,
  spawnedChildren,
  until,
} from "./fakeServeChild";

mockServeSpawn();

const debug = spyOn(Logger, "debug").mockImplementation(() => {});
const warn = spyOn(Logger, "warn").mockImplementation(() => {});
const error = spyOn(Logger, "error").mockImplementation(() => {});

const newClient = (udid?: string) =>
  new ServeClient({ binaryPath: () => "/bin/lantern-ios-profiler", udid, binaryName: "serve" });

beforeEach(() => {
  spawnedChildren.length = 0;
});
afterEach(() => {
  debug.mockClear();
  warn.mockClear();
  error.mockClear();
});
afterAll(() => mock.restore());

describe("ServeClient", () => {
  it("spawns `serve` on the first request, with --udid when a device was picked", async () => {
    const client = newClient("00008130-000");
    const pending = client.request<{ pong: boolean }>("ping");
    const child = await currentChild();

    expect(child.args).toEqual(["serve", "--udid", "00008130-000"]);
    expect(await nthRequest(child, 1)).toEqual({ id: 1, cmd: "ping" });
    child.respond(1, { pong: true });
    expect(await pending).toEqual({ pong: true });

    // The same child serves the next request
    const next = client.request("devices");
    expect(await nthRequest(child, 2)).toEqual({ id: 2, cmd: "devices" });
    child.respond(2, []);
    expect(await next).toEqual([]);
    expect(spawnedChildren).toHaveLength(1);
  });

  it("sends one request at a time, in order", async () => {
    const client = newClient();
    const first = client.request("apps");
    const second = client.request("running-apps");
    const child = await currentChild();

    expect(await nthRequest(child, 1)).toEqual({ id: 1, cmd: "apps" });
    await flush();
    expect(child.requests).toHaveLength(1);

    child.respond(1, ["a"]);
    expect(await first).toEqual(["a"]);
    expect(await nthRequest(child, 2)).toEqual({ id: 2, cmd: "running-apps" });
    child.respond(2, ["b"]);
    expect(await second).toEqual(["b"]);
  });

  it("rejects with the binary's error code and message", async () => {
    const client = newClient();
    const pending = client.request("apps");
    const child = await currentChild();
    await nthRequest(child, 1);

    child.fail(1, "BUSY", "a poll is running: send stop first");

    const rejection = await pending.catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ServeRequestError);
    expect((rejection as ServeRequestError).code).toBe("BUSY");
    expect((rejection as ServeRequestError).message).toBe("a poll is running: send stop first");
  });

  it("routes stream lines to the listener registered for the poll, and logs strays", async () => {
    const client = newClient();
    const lines: unknown[] = [];
    client.beginStream({ onLine: (line) => lines.push(line), onClosed: () => {} });
    const pending = client.request("poll", { bundleId: "com.example" });
    const child = await currentChild();
    await nthRequest(child, 1);

    child.respond(1, { polling: true });
    child.stream({ type: "status", event: "started" });
    child.stdout.write("garbage\n");
    await pending;
    await flush();

    expect(lines).toEqual([{ type: "status", event: "started" }]);
    expect(debug).toHaveBeenCalledWith("Unparseable profiler output: garbage");

    client.endStream();
    child.stream({ type: "status", event: "stopped" });
    await flush();
    expect(lines).toHaveLength(1);
    expect(debug).toHaveBeenCalledWith('Stray profiler line: {"type":"status","event":"stopped"}');
  });

  it("logs stderr markers at the matching level", async () => {
    const client = newClient();
    client.request("ping");
    const child = await currentChild();

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

  it("gives the first request longer than the next ones, and restarts a child that timed out", () => {
    jest.useFakeTimers();
    try {
      const client = newClient();
      const first = client.request("devices");
      const child = spawnedChildren[0];
      const rejection = jest.fn();
      first.catch(rejection);

      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(rejection).not.toHaveBeenCalled();
      jest.advanceTimersByTime(FIRST_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      // The wedged child is killed so the next request starts afresh
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      client.request("ping");
      expect(spawnedChildren).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("sends a request queued behind a timed-out one to the fresh child", async () => {
    jest.useFakeTimers();
    const client = newClient();
    const wedged = client.request("apps");
    const queued = client.request("running-apps");
    const wedgedRejection = jest.fn();
    const queuedRejection = jest.fn();
    wedged.catch(wedgedRejection);
    queued.catch(queuedRejection);

    jest.advanceTimersByTime(FIRST_REQUEST_TIMEOUT_MS);
    jest.useRealTimers();
    await flush();

    // The queued request is not collateral damage of the timeout: it is sent to a new child
    expect(queuedRejection).not.toHaveBeenCalled();
    expect(spawnedChildren).toHaveLength(2);
    expect((await nthRequest(spawnedChildren[1], 1)).cmd).toBe("running-apps");
    await expect(wedged).rejects.toThrow(
      `serve did not answer apps within ${FIRST_REQUEST_TIMEOUT_MS}ms`
    );
  });

  it("does not let a `devices` answer shorten the timeout of the request that opens the tunnel", async () => {
    const client = newClient();
    const listing = client.request("devices");
    const child = await currentChild();
    child.respond((await nthRequest(child, 1)).id, []);
    await listing;

    jest.useFakeTimers();
    try {
      client.request("apps").catch(() => {});
      // `devices` only lists over usbmuxd, so the tunnel bring-up still gets the long budget
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(child.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(FIRST_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      jest.useRealTimers();
    }
  });

  it("shortens the timeout once a request that opens the device connection was answered", async () => {
    const client = newClient();
    const opening = client.request("apps");
    const child = await currentChild();
    child.respond((await nthRequest(child, 1)).id, []);
    await opening;

    jest.useFakeTimers();
    try {
      client.request("running-apps").catch(() => {});
      jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      jest.useRealTimers();
    }
  });

  it("pinUdid() retires an idle child so the next one targets the resolved device", async () => {
    const client = newClient();
    const listing = client.request("devices");
    const child = await currentChild();
    expect(child.args).toEqual(["serve"]);
    child.respond((await nthRequest(child, 1)).id, []);
    await listing;

    client.pinUdid("00008130-000");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.exitCode = 0;
    child.emit("close", 0, null);
    // Dropped on purpose: the exit must not be reported as a crash
    expect(error).not.toHaveBeenCalled();

    client.request("apps").catch(() => {});
    expect(spawnedChildren[1].args).toEqual(["serve", "--udid", "00008130-000"]);
  });

  it("pinUdid() leaves a busy child alone, and the pin applies to its replacement", async () => {
    const client = newClient();
    client.request("poll").catch(() => {});
    const child = await currentChild();
    await nthRequest(child, 1);

    client.pinUdid("00008130-000");
    expect(child.kill).not.toHaveBeenCalled();

    child.exitCode = 1;
    child.emit("close", 1, null);
    client.request("apps").catch(() => {});
    expect(spawnedChildren[1].args).toEqual(["serve", "--udid", "00008130-000"]);
  });

  it("times out with a message naming the request", async () => {
    jest.useFakeTimers();
    try {
      const client = newClient();
      const first = client.request("devices");
      jest.advanceTimersByTime(FIRST_REQUEST_TIMEOUT_MS);
      await expect(first).rejects.toThrow(
        `serve did not answer devices within ${FIRST_REQUEST_TIMEOUT_MS}ms`
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails the pending request and the stream when the child dies, then respawns", async () => {
    const client = newClient();
    const onClosed = jest.fn();
    client.beginStream({ onLine: () => {}, onClosed });
    const pending = client.request("apps");
    const child = await currentChild();
    await nthRequest(child, 1);

    child.exitCode = 1;
    child.emit("close", 1, null);

    await expect(pending).rejects.toThrow("serve exited unexpectedly (code 1)");
    expect(onClosed).toHaveBeenCalledWith("serve exited unexpectedly (code 1)");
    expect(error).toHaveBeenCalledWith("serve exited unexpectedly (code 1)");
    expect(client.isRunning).toBe(false);

    client.request("ping");
    await until(() => spawnedChildren.length === 2, "a second child");
  });

  it("dispose() closes stdin, then SIGINT, then SIGKILL; the exit is not an error", async () => {
    jest.useFakeTimers();
    try {
      const client = newClient();
      const pending = client.request("ping");
      const child = spawnedChildren[0];

      client.dispose();
      expect(child.stdin.writableEnded).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGINT");

      jest.advanceTimersByTime(3000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      // Whatever was still pending is over, but that is not an unexpected exit
      await expect(pending).rejects.toThrow("serve stopped (signal SIGKILL)");
      expect(error).not.toHaveBeenCalled();
      expect(client.isRunning).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("dispose() without a child is a no-op", () => {
    const client = newClient();
    client.dispose();
    expect(spawnedChildren).toHaveLength(0);
  });
});
