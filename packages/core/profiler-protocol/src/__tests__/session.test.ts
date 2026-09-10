import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { Measure } from "@lantern/types";
import {
  ProfilingSessionBase,
  describeExit,
  disposeAllSessions,
  installSignalHandlers,
  liveSessionCount,
  terminateChild,
} from "..";

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof jest.fn>;
}

const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild;
  child.kill = jest.fn(() => true);
  return child;
};

const measure = (time: number): Measure => ({ cpu: { perName: {}, perCore: {} }, time });

/** A session over one fake child, with the platform hooks exposed to the tests */
class FakeSession extends ProfilingSessionBase {
  child = fakeChild();
  stopRequested = false;
  disposeCalls = 0;

  constructor(
    bundleId = "com.example",
    private readonly launchError?: Error
  ) {
    super(bundleId);
    this.start();
  }

  protected async launch(): Promise<void> {
    if (this.launchError) throw this.launchError;
    this.child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const exit = describeExit(code, signal);
      this.emitEnded(this.stopRequested ? `stopped (${exit})` : `exited unexpectedly (${exit})`);
    });
  }

  protected async doStop(): Promise<void> {
    this.stopRequested = true;
    terminateChild(this.child as unknown as ChildProcess);
    await this.ended;
  }

  protected doDispose(): void {
    this.disposeCalls++;
    this.child.kill("SIGKILL");
  }

  reportStarted() {
    this.emitStarted();
  }

  push(sample: Measure) {
    this.emitMeasure(sample);
  }

  restart() {
    this.emitRestarted();
  }
}

const collect = async (iterable: AsyncIterable<Measure>) => {
  const seen: Measure[] = [];
  for await (const sample of iterable) seen.push(sample);
  return seen;
};

afterEach(() => {
  disposeAllSessions();
});

describe("ProfilingSessionBase", () => {
  it("resolves launched and started, and fires started once", async () => {
    const session = new FakeSession();
    const started = jest.fn();
    session.on("started", started);

    await session.launched;
    session.reportStarted();
    session.reportStarted();
    await session.started;

    expect(started).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("delivers every measure received before the exit, then ends the iterator and stop()", async () => {
    const session = new FakeSession();
    const listener = jest.fn();
    session.on("measure", listener);
    const collected = collect(session.measures());
    const restarted = jest.fn();
    session.on("restarted", restarted);

    session.push(measure(0));
    session.restart();
    session.push(measure(500));

    const stopping = session.stop();
    // stop() is idempotent: the second call joins the first
    expect(session.stop()).toBe(stopping);
    expect(session.child.kill).toHaveBeenCalledWith("SIGINT");

    let stopped = false;
    stopping.then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    session.push(measure(1000));
    session.child.emit("close", null, "SIGINT");
    await stopping;

    expect(await collected).toEqual([measure(0), measure(500), measure(1000)]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(restarted).toHaveBeenCalledTimes(1);
    expect(await session.ended).toBe("stopped (signal SIGINT)");
  });

  it("rejects started and ends when the profiler exits early", async () => {
    const session = new FakeSession();
    const ended = jest.fn();
    session.on("ended", ended);
    const collected = collect(session.measures());

    session.child.emit("close", 1, null);

    await expect(session.started).rejects.toThrow("exited unexpectedly (code 1)");
    expect(await session.ended).toBe("exited unexpectedly (code 1)");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(await collected).toEqual([]);
    // Already over: stop() has nothing to wait for
    await session.stop();
  });

  it("ends the session when the launch fails", async () => {
    const session = new FakeSession("com.example", new Error("screenrecord failed"));

    await expect(session.launched).rejects.toThrow("screenrecord failed");
    await expect(session.started).rejects.toThrow("screenrecord failed");
    expect(await session.ended).toBe("screenrecord failed");
  });

  it("ends an iterator created after the session ended", async () => {
    const session = new FakeSession();
    session.child.emit("close", 0, null);
    await session.ended;

    expect(await collect(session.measures())).toEqual([]);
  });

  it("disposes once, and unsubscribes listeners on demand", () => {
    const session = new FakeSession();
    const listener = jest.fn();
    const off = session.on("measure", listener);
    session.push(measure(0));
    off();
    session.push(measure(500));
    expect(listener).toHaveBeenCalledTimes(1);

    session.dispose();
    session.dispose();
    expect(session.disposeCalls).toBe(1);
    expect(session.child.kill).toHaveBeenCalledTimes(1);
  });

  it("is tracked while live and untracked once ended", async () => {
    const before = liveSessionCount();
    const session = new FakeSession();
    expect(liveSessionCount()).toBe(before + 1);

    session.child.emit("close", 0, null);
    await session.ended;
    expect(liveSessionCount()).toBe(before);
  });
});

describe("terminateChild", () => {
  it("escalates to SIGKILL when the child lingers, not when it exited in time", () => {
    jest.useFakeTimers();
    try {
      const lingering = fakeChild();
      const onEscalate = jest.fn();
      terminateChild(lingering as unknown as ChildProcess, { onEscalate });
      expect(lingering.kill).toHaveBeenCalledWith("SIGINT");
      jest.advanceTimersByTime(3000);
      expect(lingering.kill).toHaveBeenCalledWith("SIGKILL");
      expect(onEscalate).toHaveBeenCalledTimes(1);

      const prompt = fakeChild();
      terminateChild(prompt as unknown as ChildProcess);
      prompt.emit("close", 0, null);
      jest.advanceTimersByTime(3000);
      expect(prompt.kill).toHaveBeenCalledTimes(1);
      expect(prompt.kill).toHaveBeenCalledWith("SIGINT");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("installSignalHandlers", () => {
  const fakeProcess = () => {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      target: {
        on: jest.fn((signal: string, handler: () => void) => {
          handlers.set(signal, handler);
        }),
        exit: jest.fn(),
      },
    };
  };

  it("disposes every live session and exits with the signal's code on SIGINT", () => {
    const { handlers, target } = fakeProcess();
    installSignalHandlers(target as unknown as NodeJS.Process);
    const first = new FakeSession("com.first");
    const second = new FakeSession("com.second");

    handlers.get("SIGINT")!();

    expect(first.disposeCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
    expect(target.exit).toHaveBeenCalledWith(130);
  });

  it("registers each signal once per process, whatever the number of calls", () => {
    const { handlers, target } = fakeProcess();
    installSignalHandlers(target as unknown as NodeJS.Process);
    installSignalHandlers(target as unknown as NodeJS.Process);

    expect(target.on).toHaveBeenCalledTimes(3);
    expect(Array.from(handlers.keys()).sort()).toEqual(["SIGINT", "SIGQUIT", "SIGTERM"]);

    handlers.get("SIGTERM")!();
    expect(target.exit).toHaveBeenCalledWith(143);
  });

  it("keeps going when one session fails to dispose", () => {
    const { handlers, target } = fakeProcess();
    installSignalHandlers(target as unknown as NodeJS.Process);
    const broken = new FakeSession("com.broken");
    broken.child.kill = jest.fn(() => {
      throw new Error("EPERM");
    });
    const fine = new FakeSession("com.fine");

    handlers.get("SIGQUIT")!();

    expect(fine.disposeCalls).toBe(1);
    expect(target.exit).toHaveBeenCalledWith(131);
  });
});
