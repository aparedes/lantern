import type {
  Measure,
  ProfilingSession,
  ProfilingSessionEvents,
  StartSessionOptions,
} from "@lantern/types";
import { trackSession, untrackSession } from "./registry";

type Listeners = { [E in keyof ProfilingSessionEvents]: Set<ProfilingSessionEvents[E]> };

/**
 * Everything a `ProfilingSession` needs besides the platform-specific process handling: the
 * event fan-out, the `launched` / `started` / `ended` promises, the measure iterator, the
 * live-session registry and idempotent stop/dispose.
 *
 * Subclasses spawn their processes from `launch()`, feed `emitMeasure` / `emitStarted` /
 * `emitRestarted`, end with `emitEnded` (once the profiler process is gone) and implement
 * `doStop` (graceful) and `doDispose` (synchronous kill).
 */
export abstract class ProfilingSessionBase implements ProfilingSession {
  readonly launched: Promise<void>;
  readonly started: Promise<void>;
  readonly ended: Promise<string>;
  recordingStartTime: number | undefined;

  private resolveLaunched!: () => void;
  private rejectLaunched!: (error: Error) => void;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private resolveEnded!: (reason: string) => void;

  private launchSettled = false;
  private hasStarted = false;
  private endReason: string | undefined;
  private stopping: Promise<void> | undefined;
  protected disposed = false;

  private readonly listeners: Listeners = {
    measure: new Set(),
    started: new Set(),
    restarted: new Set(),
    ended: new Set(),
  };

  constructor(
    readonly bundleId: string,
    protected readonly options: StartSessionOptions = {}
  ) {
    this.launched = new Promise<void>((resolve, reject) => {
      this.resolveLaunched = resolve;
      this.rejectLaunched = reject;
    });
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.ended = new Promise<string>((resolve) => {
      this.resolveEnded = resolve;
    });
    // Nothing may ever await these (e.g. the test failed on its own first): a rejection must
    // not surface as unhandled
    this.launched.catch(() => {});
    this.started.catch(() => {});

    trackSession(this);
  }

  /**
   * Kicks off the platform-specific setup. Called by the platform's `startSession` right after
   * construction (not from the constructor: subclasses need their fields initialised first).
   */
  protected start(): void {
    this.launch().then(
      () => this.settleLaunched(),
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.settleLaunched(new Error(reason));
        this.emitEnded(reason);
      }
    );
  }

  /** Starts the recording (if any) and spawns the profiler; must not spawn anything once `disposed`. */
  protected abstract launch(): Promise<void>;
  /** Asks the profiler to exit and resolves once `ended` fired; then stops the recording, if any. */
  protected abstract doStop(): Promise<void>;
  /** Kills every child synchronously. Called at most once. */
  protected abstract doDispose(): void;

  on<E extends keyof ProfilingSessionEvents>(
    event: E,
    listener: ProfilingSessionEvents[E]
  ): () => void {
    const listeners = this.listeners[event] as Set<ProfilingSessionEvents[E]>;
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  measures(): AsyncIterable<Measure> {
    const queue: Measure[] = [];
    let done = this.endReason !== undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const offMeasure = this.on("measure", (measure) => {
      queue.push(measure);
      notify();
    });
    const offEnded = this.on("ended", () => {
      done = true;
      notify();
    });
    const finish = (): IteratorResult<Measure> => {
      offMeasure();
      offEnded();

      return { value: undefined, done: true };
    };

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const measure = queue.shift();

          return measure ? { value: measure, done: false } : finish();
        },
        return: async () => finish(),
      }),
    };
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();

    return this.stopping;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.doDispose();
  }

  protected emitMeasure(measure: Measure) {
    this.listeners.measure.forEach((listener) => listener(measure));
  }

  protected emitStarted() {
    if (this.hasStarted) return;
    this.hasStarted = true;
    this.resolveStarted();
    this.listeners.started.forEach((listener) => listener());
  }

  protected emitRestarted() {
    this.listeners.restarted.forEach((listener) => listener());
  }

  /** Fires `ended` exactly once; later calls are ignored. */
  protected emitEnded(reason: string) {
    if (this.endReason !== undefined) return;
    this.endReason = reason;
    untrackSession(this);
    this.settleLaunched(new Error(reason));
    if (!this.hasStarted) this.rejectStarted(new Error(reason));
    this.resolveEnded(reason);
    this.listeners.ended.forEach((listener) => listener(reason));
  }

  protected get hasEnded(): boolean {
    return this.endReason !== undefined;
  }

  private settleLaunched(error?: Error) {
    if (this.launchSettled) return;
    this.launchSettled = true;
    if (error) this.rejectLaunched(error);
    else this.resolveLaunched();
  }
}
