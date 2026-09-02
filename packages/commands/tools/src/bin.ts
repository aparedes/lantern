#!/usr/bin/env bun

import { program } from "commander";
import { Logger } from "@lantern/logger";
import { installSignalHandlers } from "@lantern/profiler";
import { registerToolsCommand } from "./command";

installSignalHandlers();
registerToolsCommand(program);
program.parseAsync().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
