import type { DeviceInfo } from "@lantern/types";

/** The device to profile could not be picked; the message tells the user what to pass. */
export class DeviceSelectionError extends Error {}

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
        `Unknown ${platformName} device "${requested}" (${connected})`
      );
    }

    return device;
  }

  if (devices.length === 0) {
    throw new DeviceSelectionError(`No ${platformName} device connected`);
  }
  if (devices.length > 1) {
    throw new DeviceSelectionError(
      `Several ${platformName} devices are connected (${ids.join(", ")}): pass --device <${idLabel}>`
    );
  }

  return devices[0];
};
