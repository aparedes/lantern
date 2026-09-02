export interface CpuMeasure {
  perName: { [processName: string]: number };
  perCore: { [core: number]: number };
}

export interface Measure {
  cpu: CpuMeasure;
  ram?: number;
  fps?: number;
  time: number;
}

export interface HistogramValue {
  renderingTime: number;
  frameCount: number;
}

export type TestCaseIterationStatus = "SUCCESS" | "FAILURE";

export interface TestCaseIterationResult {
  time: number;
  // we probably don't need this but this is added by the PerformanceMeasurer
  startTime?: number;
  measures: Measure[];
  status: TestCaseIterationStatus;
  videoInfos?: {
    path: string;
    startOffset: number;
  };
  isRetriedIteration?: boolean;
}

export type TestCaseResultStatus = "SUCCESS" | "FAILURE"; // Todo: add "SUCCESS_WITH_SOME_ITERATIONS_FAILED"

export interface TestCaseResult {
  name: string;
  score?: number;
  status: TestCaseResultStatus;
  iterations: TestCaseIterationResult[];
  specs?: DeviceSpecs;
}

export interface AveragedTestCaseResult {
  name: string;
  score?: number;
  status: TestCaseResultStatus;
  iterations: TestCaseIterationResult[];
  average: TestCaseIterationResult;
  averageHighCpuUsage: { [processName: string]: number };
  specs?: DeviceSpecs;
}

// Shouldn't really be here but @lantern/types is imported by everyone and doesn't contain any logic
// so nice to have it here for now
export const POLLING_INTERVAL = 500;

export type Platform = "android" | "ios";

export interface AppInfo {
  bundleId: string;
  /** Human-readable name when the platform provides one, else the bundle id. */
  name: string;
  /** Set by platforms that can tell (iOS); undefined means unknown. */
  isRunning?: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  /** iOS model identifier (e.g. "iPhone16,1"), when known. */
  model?: string;
}

export const ThreadNames = {
  ANDROID: {
    UI: "UI Thread",
  },
  IOS: {
    UI: "Main Thread",
  },
  FLUTTER: {
    UI: "1.ui",
    RASTER: "1.raster",
    IO: "1.io",
  },
  RN: {
    JS_ANDROID: "mqt_js",
    JS_BRIDGELESS_ANDROID: "mqt_v_js",
    OLD_BRIDGE: "mqt_native_modu",
    JS_IOS: "com.facebook.react.JavaScript",
  },
};

export interface ScreenRecorder {
  startRecording({ bitRate, size }: { bitRate?: number; size?: string }): Promise<void>;
  stopRecording(): Promise<void>;
  pullRecording: (path: string) => Promise<void>;
  getRecordingStartTime: () => number;
}

export type ProfilingSessionEvents = {
  /** One processed measure. */
  measure: (measure: Measure) => void;
  /** The profiler reported its first sample: the run is covered by measures from now on. */
  started: () => void;
  /**
   * The app process was replaced (Android pid change): aggregation restarted, the measures
   * received so far describe a process that no longer exists.
   */
  restarted: () => void;
  /** The profiler process is gone; `reason` is a short human-readable description. Fires exactly once. */
  ended: (reason: string) => void;
};

/**
 * One profiling run of one app: owns every process it spawns (the profiler itself, and on
 * Android atrace and the screen recorder) from `startSession` until `ended`.
 */
export interface ProfilingSession {
  readonly bundleId: string;
  /**
   * Resolves once the screen recording (if any) is on and the profiler process has been
   * spawned; rejects when that setup fails (the session is then ended).
   */
  readonly launched: Promise<void>;
  /** Resolves on the first sample; rejects with the end reason if the profiler ends first. */
  readonly started: Promise<void>;
  /** Resolves with the end reason once the profiler process has exited. Never rejects. */
  readonly ended: Promise<string>;
  /** `performance.now()` when the screen recording started, when one was requested and did start. */
  readonly recordingStartTime: number | undefined;
  /** Subscribes to a lifecycle event; returns the unsubscribe function. */
  on<E extends keyof ProfilingSessionEvents>(
    event: E,
    listener: ProfilingSessionEvents[E]
  ): () => void;
  /** Measures in arrival order; the iterator ends with the session. */
  measures(): AsyncIterable<Measure>;
  /**
   * Graceful stop: stops the profiler and waits for its exit, then stops and pulls the screen
   * recording if any. Idempotent; every measure the profiler printed has been delivered once
   * it resolves.
   */
  stop(): Promise<void>;
  /**
   * Immediate, synchronous teardown for signal handlers and force stops: kills every child
   * (profiler, atrace, screen recorder) and leaves the device tracing off. Safe to call any
   * number of times, and after `stop()`.
   */
  dispose(): void;
}

export interface StartSessionOptions {
  /** Record the screen for the whole session (Android only); the file lands next to `videoPath`. */
  recording?: { videoPath: string; bitRate?: number; size?: string };
}

export interface Profiler {
  startSession: (bundleId: string, options?: StartSessionOptions) => ProfilingSession;
  /**
   * The device this profiler works with: the one asked for (`--device`), else the only
   * connected one. Throws a `DeviceSelectionError` naming the connected devices otherwise.
   */
  resolveDevice: () => DeviceInfo;
  detectCurrentBundleId: () => string;
  installProfilerOnDevice: () => void;
  /** Whether `StartSessionOptions.recording` is honoured on this platform. */
  supportsScreenRecording: () => boolean;
  stopApp: (bundleId: string) => Promise<void>;
  detectDeviceRefreshRate: () => number;
  /** Installed, user-launchable apps. Used to populate the measure web app's picker. */
  listApps: () => Promise<AppInfo[]>;
  /** Devices reachable right now; `[]` when the platform tooling is missing. Must not throw. */
  listDevices: () => DeviceInfo[];
}

export interface DeviceSpecs {
  refreshRate: number;
}
