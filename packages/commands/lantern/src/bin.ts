#!/usr/bin/env bun

import { Logger } from "@lantern/logger";
import { installSignalHandlers } from "@lantern/profiler";
import { createProgram } from "./cli";

installSignalHandlers();
createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    Logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
