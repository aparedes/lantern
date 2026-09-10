import { adb } from "./adb";

/**
 * Whether a process with the given name (binary name or bundle id) is running on the device.
 *
 * `pidof` exits with a non zero code (which makes `adb` throw) when no process matches.
 */
export const isDeviceProcessRunning = (processName: string, serial?: string): boolean => {
  try {
    return adb(["shell", "pidof", processName], { serial }).trim() !== "";
  } catch {
    return false;
  }
};
