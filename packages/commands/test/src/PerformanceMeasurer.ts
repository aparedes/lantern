import { Logger } from "@lantern/logger";
import { profiler, waitFor } from "@lantern/profiler";
import { Trace } from "./Trace";
import {
  Measure,
  POLLING_INTERVAL,
  ProfilingSession,
  TestCaseIterationResult,
} from "@lantern/types";

/**
 * How long the profiler gets to report that it is measuring (see `waitUntilMeasuring`). Once the
 * app runs, spawning the profiler on the device and taking a baseline sample typically takes 0.5
 * to 1.5s — but on Android the profiler only samples once the app runs, and the app may well be
 * launched by the test command itself (`beforeTest` force-stops it, see `command.ts`), so this
 * also has to cover the test tooling starting the app.
 */
export const START_MEASURING_TIMEOUT = 30000;

export class PerformanceMeasurer {
  measures: Measure[] = [];
  session?: ProfilingSession;
  timingTrace?: Trace;

  private forceStopped = false;
  /** Settles once the profiler reported its first sample or gave up, see `waitUntilMeasuring` */
  private measuringStarted?: Promise<void>;
  /** Settles `measuringStarted` when the measurer is stopped before the profiler reported anything */
  private resolvePendingStart?: () => void;

  constructor(
    private bundleId: string,
    private options: {
      recordOptions:
        | { record: false }
        | {
            record: true;
            size?: string;
            bitRate?: number;
            videoPath: string;
          };
      /** Overrides `START_MEASURING_TIMEOUT` (in ms) */
      startTimeout?: number;
    }
  ) {}

  /**
   * Starts the session (recording, then profiler). Resolves once the profiler is spawned: whether
   * it then manages to measure is reported by `waitUntilMeasuring` / `runWhileMeasuring`.
   */
  async start(
    onMeasure: (measure: Measure) => void = () => {
      // noop by default
    }
  ) {
    // Stopped before we even started: there is nothing to measure
    if (this.forceStopped) return;

    const { recordOptions } = this.options;
    const session = profiler.startSession(this.bundleId, {
      recording: recordOptions.record
        ? {
            videoPath: recordOptions.videoPath,
            bitRate: recordOptions.bitRate,
            size: recordOptions.size,
          }
        : undefined,
    });
    this.session = session;

    const restart = () => {
      this.measures = [];
      this.timingTrace = new Trace();
    };
    session.on("measure", (measure) => {
      this.measures.push(measure);
      onMeasure(measure);
      Logger.debug(`Received measure ${this.measures.length}`);
    });
    session.on("started", restart);
    session.on("restarted", restart);

    const timeout = this.options.startTimeout ?? START_MEASURING_TIMEOUT;

    this.measuringStarted = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.resolvePendingStart = undefined;
        callback();
      };

      const timeoutId = setTimeout(() => {
        session.dispose();
        settle(() =>
          reject(
            new Error(
              `The profiler did not start measuring within ${timeout}ms, is "${this.bundleId}" running on the device?`
            )
          )
        );
      }, timeout);

      this.resolvePendingStart = () => settle(resolve);

      session.started.then(
        () => settle(resolve),
        // Only relevant while we are still waiting for the first sample, a no-op afterwards
        (error: Error) =>
          settle(() =>
            reject(new Error(`The profiler stopped before it started measuring: ${error.message}`))
          )
      );
    });
    // Nothing may ever await it (e.g. the test failed on its own first): a rejection must not
    // surface as unhandled
    this.measuringStarted.catch(() => {});

    // e.g. the screen recording could not start: fail here, like the recording did before
    await session.launched;
  }

  /**
   * Resolves once the profiler has reported that it is measuring, i.e. the run is covered by
   * measures from then on. Rejects if it never gets there (`START_MEASURING_TIMEOUT` elapsed, or
   * the profiler exited first). Resolves right away when the measurer was force stopped.
   */
  waitUntilMeasuring(): Promise<void> {
    return this.measuringStarted ?? Promise.resolve();
  }

  /**
   * Runs `task` while waiting for the profiler to start measuring, and fails as soon as the
   * profiler cannot, rather than once `task` is over. The wait cannot come before `task`: on
   * Android the profiler only takes its first sample once the app runs, and the app may be
   * launched by `task` itself (see `START_MEASURING_TIMEOUT`).
   */
  runWhileMeasuring<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waitUntilMeasuring().catch(reject);
      Promise.resolve().then(task).then(resolve, reject);
    });
  }

  forceStop() {
    this.forceStopped = true;
    this.resolvePendingStart?.();
    this.session?.dispose();
  }

  async stop(duration?: number): Promise<TestCaseIterationResult> {
    // The run may be over before the profiler took its first sample (see `runWhileMeasuring`):
    // give it its chance rather than reporting no measures — or its failure to start, if any.
    // A `forceStop()` settles this wait right away.
    await this.waitUntilMeasuring();

    const time = this.timingTrace?.stop();

    if (duration) {
      // Hack to wait for the duration to be reached in case test case has finished before
      await waitFor(() => this.measures.length * POLLING_INTERVAL > duration, {
        checkInterval: POLLING_INTERVAL,
        timeout: duration * 2,
        errorMessage:
          "We don't have enough measures for the duration of the test specified, maybe the app has crashed?",
      });
    }

    // Waits for the profiler to exit: every measure it printed has been delivered by then
    await this.session?.stop();

    if (duration) {
      this.measures = this.measures.slice(0, duration / POLLING_INTERVAL + 1);
    }

    if (this.measures.length === 0) {
      throw new Error(
        `No measures were received from the profiler for "${this.bundleId}", maybe the app has crashed or was never started?`
      );
    }

    const startTime = this.timingTrace?.startTime ?? 0;
    const recordingStartTime = this.session?.recordingStartTime;

    return {
      time: time ?? 0,
      startTime,
      measures: this.measures,
      status: "SUCCESS",
      videoInfos:
        this.options.recordOptions.record && recordingStartTime !== undefined
          ? {
              path: this.options.recordOptions.videoPath,
              startOffset: Math.floor(startTime - recordingStartTime),
            }
          : undefined,
    };
  }
}
