import { adb } from "./adb";
import { Logger } from "@lantern/logger";

const DEFAULT_FRAME_RATE = 60;

/** The pipeline runs on the device's shell, so it is one adb argument. */
const DUMPSYS_DISPLAY = 'dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"';

export const detectCurrentDeviceRefreshRate = (serial?: string) => {
  const commandOutput = adb(["shell", DUMPSYS_DISPLAY], { serial });

  const renderFrameRateMatch = commandOutput.match(/renderFrameRate\s+(\d+\.?\d*)/);

  if (renderFrameRateMatch) {
    Logger.debug(`Detected device refresh rate: ${renderFrameRateMatch[1]} Hz`);
    return Math.round(parseFloat(renderFrameRateMatch[1]));
  }

  const matches = commandOutput.matchAll(/fps=(\d+\.?\d*)/g);
  const refreshRates = Array.from(matches, (match) => parseFloat(match[1]));
  refreshRates.sort((a, b) => b - a);

  if (refreshRates.length === 0) {
    throw new Error(
      `Could not detect device refresh rate, ${
        commandOutput
          ? `output of adb shell ${DUMPSYS_DISPLAY} was ${commandOutput}`
          : "do you have an Android device connected and unlocked?"
      }`
    );
  }

  Logger.debug(`Detected device refresh rate: ${refreshRates[0]} Hz`);

  return Math.round(refreshRates[0]);
};

/** The device's refresh rate, or `DEFAULT_FRAME_RATE` when it cannot be detected (logged). */
export const detectRefreshRateOrDefault = (serial?: string): number => {
  try {
    const refreshRate = detectCurrentDeviceRefreshRate(serial);
    Logger.info(`Target frame rate: ${refreshRate} Hz`);

    return refreshRate;
  } catch (e) {
    Logger.error(`Could not detect device refresh rate: ${e}`);

    return DEFAULT_FRAME_RATE;
  }
};
