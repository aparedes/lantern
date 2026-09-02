#!/usr/bin/env bun

import { program } from "commander";
import { installSignalHandlers } from "@lantern/profiler";
import { registerMeasureCommand } from "./command";

installSignalHandlers();
registerMeasureCommand(program);
program.parse();
