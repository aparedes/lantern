#!/usr/bin/env bun

import { Logger } from "@lantern/logger";
import { Measure } from "@lantern/types";
import { program } from "commander";
import { detectCurrentAppBundleId } from "./commands/detectCurrentAppBundleId";
import { getPidId } from "./commands/getPidId";
import { getAbi } from "./commands/getAbi";
import { installSignalHandlers } from "@lantern/profiler-protocol";
import { AndroidProfiler } from "./commands/platforms/AndroidProfiler";

installSignalHandlers();

program.option(
  "--device <serial>",
  "Serial of the device to use; required when several devices are connected"
);

let profiler: AndroidProfiler | undefined;
const getProfiler = () => (profiler ??= new AndroidProfiler({ serial: program.opts().device }));
/** The resolved serial, for the helpers called outside of a profiler. */
const serial = async () => (await getProfiler().resolveDevice()).id;

const debugCppConfig = async () => {
  const profiler = getProfiler();
  await profiler.installProfilerOnDevice();
  Logger.success(`CPU Clock tick: ${profiler.getCpuClockTick()}`);
  Logger.success(`RAM Page size: ${profiler.getRAMPageSize()}`);
};

program.command("debugCppConfig").description("Debug CPP Config").action(debugCppConfig);

program
  .command("getCurrentAppBundleId")
  .description("Retrieves the focused app bundle id")
  .action(async () => {
    const { bundleId } = detectCurrentAppBundleId(await serial());
    console.log(bundleId);
  });

program
  .command("getCurrentAppPid")
  .description("Retrieves the focused app process id")
  .action(async () => {
    const deviceSerial = await serial();
    const { bundleId } = detectCurrentAppBundleId(deviceSerial);
    console.log(getPidId(bundleId, deviceSerial));
  });

program
  .command("getCurrentApp")
  .description("Prints out bundle id and currently focused app activity")
  .action(async () => {
    const { bundleId, appActivity } = detectCurrentAppBundleId(await serial());
    console.log(`bundleId=${bundleId}\nappActivity=${appActivity}`);
  });

program
  .command("getAbi")
  .description("Retrieves ABI architecture of the device")
  .action(async () => {
    console.log(getAbi(await serial()));
  });

program
  .command("profile")
  .description("Retrieves ABI architecture of the device")
  .option(
    "--bundleId <bundleId>",
    "Bundle id for the app (e.g. com.twitter.android). Defaults to the currently focused app."
  )
  .option("--fps", "Display FPS")
  .option("--ram", "Display RAM Usage")
  .option("--threadNames <threadNames...>", "Display CPU Usage for a given threads (e.g. (mqt_js))")
  .action(async (options) => {
    const bundleId = options.bundleId || detectCurrentAppBundleId(await serial()).bundleId;

    getProfiler()
      .startSession(bundleId)
      .on("measure", (measure: Measure) => {
        const headers: string[] = [];
        const values: (number | undefined)[] = [];

        if (options.fps) {
          headers.push("FPS");
          values.push(measure.fps);
        }

        if (options.ram) {
          headers.push("RAM");
          values.push(measure.ram);
        }

        if (options.threadNames) {
          options.threadNames.forEach((thread: string) => {
            headers.push(`CPU ${thread}`);
            values.push(measure.cpu.perName[thread]);
          });
        }

        console.log(headers.join("|"));
        console.log(values.join("|"));
      });
  });

program.parseAsync().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
