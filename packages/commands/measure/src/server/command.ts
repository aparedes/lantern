import { Command } from "commander";
import { CommonOptions, applyCommonOptions, registerCommonOptions } from "@lantern/profiler";
import { DEFAULT_PORT } from "./constants";

export const registerMeasureCommand = (program: Command) => {
  const measureCommand = program
    .command("measure")
    .summary("Measure the performance of an Android or iOS app")
    .description(
      `Measure the performance of an Android or iOS app. Display the results live in a web app.

Main usage:
lantern measure
lantern measure --platform ios`
    )
    .option("-p, --port [port]", "Specify the port number for the server");

  registerCommonOptions(measureCommand).action(
    async (options: CommonOptions & { port?: string }) => {
      // Resolved before Ink takes over the terminal, so a missing or ambiguous device is a plain
      // error message rather than something the web app has to surface
      await applyCommonOptions(options);

      const port = Number(options.port) || DEFAULT_PORT;
      // measure command can be a bit slow to load since we run ink and the web app server, so lazy load it
      const { runServerApp } = await import("./ServerApp.js");
      await runServerApp(port);
    }
  );
};
