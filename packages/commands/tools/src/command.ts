import { Command, Option } from "commander";
import { processVideoFile } from "@lantern/shell";
import { Logger } from "@lantern/logger";
import {
  DeviceSelectionError,
  PlatformResolutionError,
  profiler,
  selectPlatformAndDevice,
} from "@lantern/profiler";
import fs from "fs";

export const registerToolsCommand = (program: Command) => {
  const toolsCommand = program.command("tools").description("Utility tools related to Lantern");

  toolsCommand
    .command("get_bundle_id")
    .description("Retrieves the bundle id of the app currently running on the device")
    .addOption(
      new Option(
        "--platform <platform>",
        "android or ios. Defaults to the PLATFORM env var, then to whichever platform has a device connected"
      ).choices(["android", "ios"])
    )
    .addOption(
      new Option(
        "--device <serial|udid>",
        "Serial (Android) or UDID (iOS) of the device to use; required when several devices of the selected platform are connected"
      )
    )
    .action((options) => {
      try {
        selectPlatformAndDevice(options.platform, options.device);
      } catch (error) {
        if (error instanceof PlatformResolutionError || error instanceof DeviceSelectionError) {
          Logger.error(error.message);
          process.exit(1);
        }
        throw error;
      }

      console.log(profiler.detectCurrentBundleId());
    });

  toolsCommand
    .command("video_fix_metadata <videoFilePath>")
    .description(
      "On certain devices the video recorded by the test command is not encoded properly; this re-encodes it"
    )
    .action(async (videoFilePath: string) => {
      const backupFilePath = `${videoFilePath}.bak`;
      fs.cpSync(videoFilePath, backupFilePath);
      await processVideoFile(backupFilePath, videoFilePath);
      Logger.success(`Re-encoded ${videoFilePath} (original kept at ${backupFilePath})`);
    });
};
