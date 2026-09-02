import { mock } from "bun:test";
import { Measure, ProfilingSession, StartSessionOptions } from "@lantern/types";
import { ProfilingSessionBase } from "@lantern/profiler-protocol";

/** The real profiler needs a first sample before it reports anything, mimic that small delay */
export const MOCK_START_DELAY = 20;

export const mockMeasure = (time = 0): Measure => ({
  cpu: { perName: {}, perCore: {} },
  ram: 0,
  fps: 60,
  time,
});

/** A session whose profiler is driven by the test (see `PerformancePollingMock`) */
export class MockSession extends ProfilingSessionBase {
  stopCalls = 0;
  disposeCalls = 0;

  constructor(bundleId: string, options: StartSessionOptions | undefined) {
    super(bundleId, options);
    this.start();
  }

  protected async launch(): Promise<void> {}

  protected async doStop(): Promise<void> {
    this.stopCalls++;
    this.end("stopped (signal SIGINT)");
  }

  protected doDispose(): void {
    this.disposeCalls++;
    this.end("stopped (signal SIGKILL)");
  }

  reportStarted() {
    this.emitStarted();
  }

  emit(measure: Measure) {
    this.emitMeasure(measure);
  }

  end(reason: string) {
    this.emitEnded(reason);
  }
}

/** Drop-in stand-in for `profiler.startSession` */
export class PerformancePollingMock {
  private current?: MockSession;
  private startTimeout?: ReturnType<typeof setTimeout>;

  /** When false, the mocked profiler never reports that it started measuring */
  startsMeasuring = true;
  /** Emit one measure right after starting so that iterations have something to report */
  emitsMeasureOnStart = true;

  emit(measure: Partial<Measure>) {
    this.current?.emit(measure as Measure);
  }

  /** Every session started so far, for assertions on stop/dispose */
  sessions: MockSession[] = [];

  isStarted() {
    return !!this.current && this.hasStarted;
  }

  private hasStarted = false;

  reset() {
    this.startsMeasuring = true;
    this.emitsMeasureOnStart = true;
    this.sessions = [];
  }

  /** The mocked profiler took its first sample (e.g. the app just got launched) */
  reportStarted = () => {
    clearTimeout(this.startTimeout);
    if (!this.current) throw new Error("The mocked profiler was not started");
    this.hasStarted = true;
    this.current.reportStarted();
    if (this.emitsMeasureOnStart) this.emit(mockMeasure(0));
  };

  /** The mocked profiler process exited */
  end = (reason: string) => {
    clearTimeout(this.startTimeout);
    this.current?.end(reason);
  };

  start = mock((bundleId: string, options?: StartSessionOptions): ProfilingSession => {
    const session = new MockSession(bundleId, options);
    this.current = session;
    this.hasStarted = false;
    this.sessions.push(session);
    session.on("ended", () => {
      clearTimeout(this.startTimeout);
      if (this.current === session) this.hasStarted = false;
    });
    this.startTimeout = setTimeout(() => {
      if (this.startsMeasuring) this.reportStarted();
    }, MOCK_START_DELAY);

    return session;
  });
}
