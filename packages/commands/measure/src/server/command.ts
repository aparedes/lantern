import { Command, Option } from "commander";
import { Logger } from "@lantern/logger";
import {
  DeviceSelectionError,
  PlatformResolutionError,
  selectPlatformAndDevice,
} from "@lantern/profiler";
import { DEFAULT_PORT } from "./constants";

export const platformOption = new Option(
  "--platform <platform>",
  "android or ios. Defaults to the PLATFORM env var, then to whichever platform has a device connected"
).choices(["android", "ios"]);

export const deviceOption = new Option(
  "--device <serial|udid>",
  "Serial (Android) or UDID (iOS) of the device to use; required when several devices of the selected platform are connected"
);

export const registerMeasureCommand = (program: Command) => {
  program
    .command("measure")
    .summary("Measure the performance of an Android or iOS app")
    .description(
      `Measure the performance of an Android or iOS app. Display the results live in a web app.

Main usage:
lantern measure
lantern measure --platform ios`
    )
    .option("-p, --port [port]", "Specify the port number for the server")
    .addOption(platformOption)
    .addOption(deviceOption)
    .action(async (options) => {
      // Resolved before Ink takes over the terminal, so a missing or ambiguous device is a plain
      // error message rather than something the web app has to surface
      try {
        const { platform, device } = await selectPlatformAndDevice(
          options.platform,
          options.device
        );
        Logger.info(`Using ${platform} device ${device.name} (${device.id})`);
      } catch (error) {
        if (error instanceof PlatformResolutionError || error instanceof DeviceSelectionError) {
          Logger.error(error.message);
          process.exit(1);
        }
        throw error;
      }

      const port = Number(options.port) || DEFAULT_PORT;
      // measure command can be a bit slow to load since we run ink and the web app server, so lazy load it
      const { runServerApp } = await import("./ServerApp.js");
      await runServerApp(port);
    });
};
