import { ChildProcess, spawn } from "child_process";
import { createInterface } from "readline";
import { Logger } from "@lantern/logger";
import {
  ProfilerLine,
  ServeRequestError,
  ServeResponse,
  describeExit,
  isServeResponse,
  parseMarkerLine,
  parseProfilerLine,
  serializeServeRequest,
  serveResponseError,
  terminateChild,
} from "@lantern/profiler-protocol";

/**
 * The first request that touches the device brings the CoreDevice tunnel up, which takes a few
 * seconds on iOS 17+ (and a `devices` listing pays one lockdown round-trip per device).
 */
export const FIRST_REQUEST_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export interface ServeClientOptions {
  /** Read at spawn time, so `LANTERN_IOS_BINARY_PATH` set later is honoured. */
  binaryPath: () => string;
  /** Passed as `--udid` so the binary works with the device the user asked for. */
  udid?: string;
  binaryName: string;
}

/** What a running poll needs from the child: its stream lines, and to know when it is gone. */
export interface StreamListener {
  onLine: (line: ProfilerLine) => void;
  /** The child exited (or was disposed) while the stream was open. */
  onClosed: (reason: string) => void;
}

interface Pending {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One `lantern-ios-profiler serve` child for the whole life of an `IOSProfiler`: requests are
 * written to its stdin one at a time (the device refuses concurrent instruments connections),
 * each answered by the `response` line with the same id; the measure/status lines of a running
 * poll go to the stream listener. The child is spawned on the first request, and again after it
 * died.
 */
export class ServeClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending: Pending | undefined;
  private readonly queue: (() => void)[] = [];
  private stream: StreamListener | undefined;
  /** Set once a request completed on the current child: the tunnel is up, later ones are quick. */
  private warmedUp = false;
  private disposing = false;

  constructor(private readonly options: ServeClientOptions) {}

  /** Whether a child is alive right now. */
  get isRunning(): boolean {
    return this.child !== undefined;
  }

  /** Sends `cmd` once every earlier request has been answered; rejects on error, timeout or exit. */
  request<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => this.send(cmd, params, resolve as (value: unknown) => void, reject));
      this.pump();
    });
  }

  /**
   * Routes the stream lines (everything that is not a response) to `listener` until
   * `endStream()`. Registered before the `poll` request is sent, so the lines that follow its
   * response in the same chunk are not missed.
   */
  beginStream(listener: StreamListener) {
    this.stream = listener;
  }

  endStream() {
    this.stream = undefined;
  }

  /** Closes stdin (the child exits on EOF, cancelling a running poll), then SIGINT / SIGKILL. */
  dispose() {
    const child = this.child;
    if (!child) return;
    this.disposing = true;
    child.stdin?.end();
    terminateChild(child, {
      onEscalate: () =>
        Logger.warn(`${this.options.binaryName} did not exit after SIGINT, sending SIGKILL`),
    });
  }

  private pump() {
    if (this.pending) return;
    const next = this.queue.shift();
    next?.();
  }

  private send(
    cmd: string,
    params: Record<string, unknown>,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ) {
    const child = this.child ?? this.spawnChild();
    const id = this.nextId++;
    const timeoutMs = this.warmedUp ? REQUEST_TIMEOUT_MS : FIRST_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // The child is wedged on this request (a dead tunnel, typically): later requests would
      // queue behind it forever, so start over with a fresh one
      this.settle(
        new Error(`${this.options.binaryName} did not answer ${cmd} within ${timeoutMs}ms`)
      );
      this.closeChild(child, "request timed out");
    }, timeoutMs);
    this.pending = { id, resolve, reject, timer };
    child.stdin?.write(serializeServeRequest({ id, cmd, ...params }));
  }

  private settle(error: Error | undefined, value?: unknown) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
    this.pump();
  }

  private spawnChild(): ChildProcess {
    const binaryPath = this.options.binaryPath();
    const child = spawn(binaryPath, [
      "serve",
      ...(this.options.udid ? ["--udid", this.options.udid] : []),
    ]);
    this.child = child;
    this.warmedUp = false;
    this.disposing = false;

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (rawLine) => this.onLine(rawLine));
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        const marker = parseMarkerLine(line);
        if (marker?.level === "error") {
          Logger.error(line);
        } else if (marker) {
          Logger.warn(line);
        } else {
          Logger.debug(line);
        }
      });
    }

    child.on("error", (error) => {
      const message = `Failed to start ${binaryPath}: ${error.message}. Build it with packages/platforms/ios/rust-profiler/build_macos.sh or set LANTERN_IOS_BINARY_PATH.`;
      Logger.error(message);
      this.closeChild(child, message);
    });
    child.on("close", (code, signal) => {
      const reason = this.disposing
        ? `${this.options.binaryName} stopped (${describeExit(code, signal)})`
        : `${this.options.binaryName} exited unexpectedly (${describeExit(code, signal)})`;
      if (!this.disposing) Logger.error(reason);
      this.closeChild(child, reason);
    });

    return child;
  }

  /** Forgets `child` (once): the pending request fails, the stream ends, the next request respawns. */
  private closeChild(child: ChildProcess, reason: string) {
    if (this.child !== child) return;
    this.child = undefined;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const stream = this.stream;
    this.stream = undefined;
    stream?.onClosed(reason);
    this.settle(new Error(reason));
  }

  private onLine(rawLine: string) {
    const line = parseProfilerLine(rawLine);
    if (!line) {
      Logger.debug(`Unparseable profiler output: ${rawLine}`);
      return;
    }
    if (isServeResponse(line)) {
      this.onResponse(line);
      return;
    }
    if (this.stream) {
      this.stream.onLine(line);
    } else {
      Logger.debug(`Stray profiler line: ${rawLine}`);
    }
  }

  private onResponse(response: ServeResponse) {
    if (this.pending?.id !== response.id) {
      Logger.debug(`Response to a request that is no longer awaited: ${JSON.stringify(response)}`);
      return;
    }
    this.warmedUp = true;
    const error = serveResponseError(response);
    if (error) this.settle(error);
    else this.settle(undefined, response.result);
  }
}

export { ServeRequestError };
