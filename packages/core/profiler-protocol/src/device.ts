import type { DeviceInfo } from "@lantern/types";
import { LanternError } from "./errors";

/** The device to profile could not be picked; the message tells the user what to pass. */
export class DeviceSelectionError extends LanternError {
  constructor(code: "NO_DEVICE" | "AMBIGUOUS_DEVICE" | "UNKNOWN_DEVICE", message: string) {
    super(code, message);
    this.name = "DeviceSelectionError";
  }
}

export interface SelectDeviceOptions {
  /** The id the user asked for (`--device`), if any. */
  requested?: string;
  /** "Android" or "iOS", for messages. */
  platformName: string;
  /** What the id is called on this platform ("serial" or "UDID"), for the `--device` hint. */
  idLabel: string;
}

/**
 * The one device a profiler works with: the requested one when it is connected, else the only
 * connected one. Anything else is an error naming the connected ids, so that the user can pass
 * `--device`.
 */
export const selectDevice = (
  devices: DeviceInfo[],
  { requested, platformName, idLabel }: SelectDeviceOptions
): DeviceInfo => {
  const ids = devices.map((device) => device.id);
  const connected = ids.length > 0 ? `connected: ${ids.join(", ")}` : "no device connected";

  if (requested !== undefined) {
    const device = devices.find(({ id }) => id === requested);
    if (!device) {
      throw new DeviceSelectionError(
        "UNKNOWN_DEVICE",
        `Unknown ${platformName} device "${requested}" (${connected})`
      );
    }

    return device;
  }

  if (devices.length === 0) {
    throw new DeviceSelectionError("NO_DEVICE", `No ${platformName} device connected`);
  }
  if (devices.length > 1) {
    throw new DeviceSelectionError(
      "AMBIGUOUS_DEVICE",
      `Several ${platformName} devices are connected (${ids.join(", ")}): pass --device <${idLabel}>`
    );
  }

  return devices[0];
};
