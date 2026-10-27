import { Command } from "commander";
import { registerSummarizeCommand } from "@lantern/analyze";
import { registerMeasureCommand } from "@lantern/measure/dist/server/command";
import { registerTestCommand } from "@lantern/e2e";
import { registerToolsCommand } from "@lantern/tools/dist/command";
import { registerReportCommand } from "@lantern/web-reporter/dist/command";
import { version } from "../package.json";

export const createProgram = () => {
  const program = new Command("lantern").version(version);
  registerMeasureCommand(program);
  registerTestCommand(program);
  registerToolsCommand(program);
  registerReportCommand(program);
  registerSummarizeCommand(program);
  return program;
};
