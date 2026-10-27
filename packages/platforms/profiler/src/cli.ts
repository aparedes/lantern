import { Command, Option } from "commander";
import { LogLevel, Logger } from "@lantern/logger";
import { DeviceInfo } from "@lantern/types";
import { PLATFORMS, ProfilerPlatform, selectPlatformAndDevice } from "./index";

/** The options `registerCommonOptions` adds, as commander hands them to the action. */
export interface CommonOptions {
  platform?: string;
  device?: string;
  logLevel?: string;
}

const LOG_LEVEL_NAMES = Object.keys(LogLevel).map((key) => key.toLocaleLowerCase());

/**
 * The options every device-facing command shares: `--platform`, `--device` and `--logLevel`.
 * Pair with `applyCommonOptions` at the start of the action.
 */
export const registerCommonOptions = (command: Command): Command =>
  command
    .addOption(
      new Option(
        "--platform <platform>",
        "android or ios. Defaults to the PLATFORM env var, then to whichever platform has a device connected"
      ).choices([...PLATFORMS])
    )
    .addOption(
      new Option(
        "--device <serial|udid>",
        "Serial (Android) or UDID (iOS) of the device to use; required when several devices of the selected platform are connected"
      )
    )
    .addOption(new Option("--logLevel <logLevel>", "Set Log level").choices(LOG_LEVEL_NAMES));

/**
 * Applies the log level, then fixes the platform and device for the process, before anything (a
 * server, a test run) starts. A platform or device that cannot be picked rejects with a
 * `PlatformResolutionError` / `DeviceSelectionError`, whose code and message the CLI's top-level
 * handler prints (see `runCli` in `@lantern/cli-core`).
 */
export const applyCommonOptions = async ({
  platform,
  device,
  logLevel,
}: CommonOptions): Promise<{ platform: ProfilerPlatform; device: DeviceInfo }> => {
  // First, so that the resolution logs below respect it
  if (logLevel) {
    Logger.setLogLevel(LogLevel[logLevel.toLocaleUpperCase() as keyof typeof LogLevel]);
  }

  const selection = await selectPlatformAndDevice(platform, device);
  Logger.info(
    `Using ${selection.platform} device ${selection.device.name} (${selection.device.id})`
  );

  return selection;
};
