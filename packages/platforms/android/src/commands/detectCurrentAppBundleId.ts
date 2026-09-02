import { adb } from "./adb";

export const detectCurrentAppBundleId = (serial?: string) => {
  const command = ["shell", "dumpsys", "window", "windows"];

  const commandOutput = adb(command, { serial })
    .split(/\r\n|\n|\r/)
    .filter(
      (line) =>
        // grep mCurrentFocus|mFocusedApp|mInputMethodTarget|mSurface
        line.includes("mCurrentFocus") ||
        line.includes("mFocusedApp") ||
        line.includes("mInputMethodTarget") ||
        line.includes("mSurface")
    )
    .filter((line) => line.includes("Activity"))
    .join("\n");

  const regexMatching = commandOutput.match(/name=([\w.]+)\/([\w.]+)\$?/);

  if (!regexMatching) {
    throw new Error(
      `Could not detect currently opened app, ${
        commandOutput
          ? `output of adb ${command.join(" ")} was ${commandOutput}`
          : "do you have an Android device connected and unlocked?"
      }`
    );
  }

  const [, bundleId, appActivity] = regexMatching;

  return { bundleId, appActivity };
};
