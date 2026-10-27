import { DeviceInfo, Profiler } from "@lantern/types";

/** Lists one platform's devices with a throwaway profiler, released right after. */
export const probeDevices = async (platformProfiler: Profiler): Promise<DeviceInfo[]> => {
  try {
    return await platformProfiler.listDevices();
  } finally {
    // The iOS profiler keeps a `serve` process alive otherwise
    platformProfiler.dispose();
  }
};
