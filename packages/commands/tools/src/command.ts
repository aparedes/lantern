import { Command, Option } from "commander";
import { processVideoFile } from "@lantern/shell";
import { Logger } from "@lantern/logger";
import { printResult, registerJsonOption } from "@lantern/cli-core";
import {
  CommonOptions,
  PLATFORMS,
  applyCommonOptions,
  listAllDevices,
  profiler,
  registerCommonOptions,
} from "@lantern/profiler";
import { AppInfo, DeviceInfo, Platform } from "@lantern/types";
import fs from "fs";

export const registerToolsCommand = (program: Command) => {
  const toolsCommand = program.command("tools").description("Utility tools related to Lantern");

  registerJsonOption(
    registerCommonOptions(
      toolsCommand
        .command("get_bundle_id")
        .description("Retrieves the bundle id of the app currently running on the device")
    )
  ).action(async (options: CommonOptions) => {
    await applyCommonOptions(options);

    try {
      printResult({ bundleId: await profiler.detectCurrentBundleId() }, ({ bundleId }) =>
        console.log(bundleId)
      );
    } finally {
      // The iOS profiler keeps a `serve` process alive; release it so the CLI can exit
      profiler.dispose();
    }
  });

  registerJsonOption(
    toolsCommand
      .command("list_devices")
      .description(
        "Lists the connected devices of both platforms (needs no --platform nor --device)"
      )
      .addOption(
        new Option("--platform <platform>", "Only list the devices of this platform").choices([
          ...PLATFORMS,
        ])
      )
  ).action(async ({ platform }: { platform?: Platform }) => {
    printResult({ devices: await listAllDevices(platform) }, ({ devices }) =>
      console.log(formatDevices(devices))
    );
  });

  registerJsonOption(
    registerCommonOptions(
      toolsCommand
        .command("list_apps")
        .description(
          "Lists the apps installed on the device (third-party apps only on Android; iOS also flags the running ones)"
        )
    )
  ).action(async (options: CommonOptions) => {
    await applyCommonOptions(options);

    try {
      printResult({ apps: await profiler.listApps() }, ({ apps }) => console.log(formatApps(apps)));
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

export const formatDevices = (devices: DeviceInfo[]) =>
  devices.length === 0
    ? "No device connected (run `lantern doctor` to find out why)"
    : devices
        .map(({ platform, id, name, model }) =>
          [platform.padEnd(8), id.padEnd(26), name, model ? `(${model})` : ""].join(" ").trimEnd()
        )
        .join("\n");

export const formatApps = (apps: AppInfo[]) =>
  apps.length === 0
    ? "No app installed"
    : apps
        .map(({ bundleId, name, isRunning }) =>
          [bundleId, name !== bundleId ? name : "", isRunning ? "(running)" : ""]
            .filter(Boolean)
            .join("  ")
        )
        .join("\n");
