import { adb } from "./adb";
import { Logger } from "@lantern/logger";

const DEFAULT_FRAME_RATE = 60;

function deviceRefreshRateManager() {
  let refreshRate: number | null = null;

  return {
    isInitialized: () => refreshRate !== null,
    getRefreshRate: () => {
      if (refreshRate === null) {
        throw new Error("Refresh rate not initialized");
      }
      return refreshRate;
    },
    setRefreshRate: (serial?: string) => {
      try {
        refreshRate = detectCurrentDeviceRefreshRate(serial);
        Logger.info(`Target frame rate: ${refreshRate} Hz`);
      } catch (e) {
        Logger.error(`Could not detect device refresh rate: ${e}`);
        refreshRate = DEFAULT_FRAME_RATE;
      }
    },
  };
}

/** The pipeline runs on the device's shell, so it is one adb argument. */
const DUMPSYS_DISPLAY = 'dumpsys display | grep -E "mRefreshRate|DisplayDeviceInfo"';

export const detectCurrentDeviceRefreshRate = (serial?: string) => {
  const commandOutput = adb(["shell", DUMPSYS_DISPLAY], { serial });

  const renderFrameRateMatch = commandOutput.match(/renderFrameRate\s+(\d+\.?\d*)/);

  if (renderFrameRateMatch) {
    Logger.debug(`Detected device refresh rate: ${renderFrameRateMatch[1]} Hz`);
    return Math.floor(parseFloat(renderFrameRateMatch[1]));
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

  return Math.floor(refreshRates[0]);
};

const refreshRateManager = deviceRefreshRateManager();

export { refreshRateManager };
