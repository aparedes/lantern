import { AndroidProfiler } from "./AndroidProfiler";
import { CppProfilerName } from "./UnixProfiler";

export class LanternSelfProfiler extends AndroidProfiler {
  // Same code as AndroidProfiler, without atrace: the profiler binary draws no frames
  protected withAtrace(): boolean {
    return false;
  }
  public supportFPS(): boolean {
    return false;
  }

  public detectCurrentBundleId(): string {
    return CppProfilerName;
  }

  public detectDeviceRefreshRate(): number {
    return 60;
  }

  /**
   * If we don't override this we end up in a situation where we have:
   *
   * 1. a normal Lantern process measuring an app
   * 2. another Lantern process measuring the performance of Lantern
   *
   * But since both have the same name, we might end up having our 2nd process
   * measuring the performance of itself instead of the 1st process
   */
  public getDeviceProfilerPath(): string {
    return `${super.getDeviceProfilerPath()}_SELF_REPORT`;
  }
}
