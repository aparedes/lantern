import { Command } from "commander";
import { processVideoFile } from "@lantern/shell";
import { Logger } from "@lantern/logger";
import {
  CommonOptions,
  applyCommonOptions,
  profiler,
  registerCommonOptions,
} from "@lantern/profiler";
import fs from "fs";

export const registerToolsCommand = (program: Command) => {
  const toolsCommand = program.command("tools").description("Utility tools related to Lantern");

  registerCommonOptions(
    toolsCommand
      .command("get_bundle_id")
      .description("Retrieves the bundle id of the app currently running on the device")
  ).action(async (options: CommonOptions) => {
    await applyCommonOptions(options);

    try {
      console.log(await profiler.detectCurrentBundleId());
    } finally {
      // The iOS profiler keeps a `serve` process alive; release it so the CLI can exit
      profiler.dispose();
    }
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
