#!/usr/bin/env bun

import { program } from "commander";
import { runCli } from "@lantern/cli-core";
import { installSignalHandlers } from "@lantern/profiler";
import { registerTestCommand } from "./command";

installSignalHandlers();
registerTestCommand(program);
void runCli(program);
