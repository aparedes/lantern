#!/usr/bin/env bun

import { program } from "commander";
import { runCli } from "@lantern/cli-core";
import { installSignalHandlers } from "@lantern/profiler";
import { registerMeasureCommand } from "./command";

installSignalHandlers();
registerMeasureCommand(program);
void runCli(program);
