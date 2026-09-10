import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { createInterface } from "readline";
import * as childProcess from "child_process";
import { expect, jest, spyOn } from "bun:test";
import type { ServeRequest } from "@lantern/profiler-protocol";

/** A `lantern-ios-profiler serve` stand-in: readline needs real streams on both sides. */
export interface FakeServeChild extends EventEmitter {
  args: string[];
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock<(signal?: NodeJS.Signals) => boolean>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** Every request line written to stdin so far, in order */
  requests: ServeRequest[];
  respond: (id: number, result: unknown) => void;
  fail: (id: number, code: string, message: string) => void;
  /** A measure/status line of the running poll */
  stream: (line: object) => void;
}

/** Every serve child spawned so far, in order */
export const spawnedChildren: FakeServeChild[] = [];

const makeChild = (args: string[]): FakeServeChild => {
  const child = new EventEmitter() as FakeServeChild;
  child.args = args;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  child.exitCode = null;
  child.signalCode = null;
  child.requests = [];
  createInterface({ input: child.stdin }).on("line", (line) => {
    child.requests.push(JSON.parse(line));
  });
  const write = (line: object) => child.stdout.write(`${JSON.stringify(line)}\n`);
  child.respond = (id, result) => write({ type: "response", id, result });
  child.fail = (id, code, message) => write({ type: "response", id, error: { code, message } });
  child.stream = write;
  return child;
};

/** Replaces `spawn` for the whole file; call once at module level. */
export const mockServeSpawn = () =>
  spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[]) => {
    expect(command.endsWith("lantern-ios-profiler")).toBe(true);
    expect(args[0]).toBe("serve");
    const child = makeChild(args);
    spawnedChildren.push(child);
    return child;
  }) as unknown as typeof childProcess.spawn);

/** Polls `predicate` (readline delivers lines asynchronously). */
export const until = async (predicate: () => boolean, what = "condition") => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** The child's `n`th request (1-based), once it has been written. */
export const nthRequest = async (child: FakeServeChild, n: number): Promise<ServeRequest> => {
  await until(() => child.requests.length >= n, `request #${n}`);
  return child.requests[n - 1];
};

/** The latest child, once spawned. */
export const currentChild = async (): Promise<FakeServeChild> => {
  await until(() => spawnedChildren.length > 0, "a serve child");
  return spawnedChildren[spawnedChildren.length - 1];
};

/** One event-loop turn, for lines already written to a stream to be dispatched. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
