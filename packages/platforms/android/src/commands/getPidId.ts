import { Logger } from "@lantern/logger";
import { adb } from "./adb";

export const getPidId = (bundleId: string, serial?: string) => {
  let commandOutput;
  const command = ["shell", "pidof", bundleId];
  try {
    commandOutput = adb(command, { serial });
  } catch {
    throw new Error(
      `Failed to find process for bundleId ${bundleId}.\n\n This command failed: adb ${command.join(" ")}`
    );
  }

  const pids = commandOutput.split(/\r\n|\n|\r/).filter(Boolean);

  if (pids.length > 1) {
    Logger.warn(`Multiple pids found (${pids.join(", ")}), selecting the first one`);
  }

  const pid = pids[0];

  Logger.debug(`Pid ${pid} found for bundle id ${bundleId}`);

  return pid;
};
