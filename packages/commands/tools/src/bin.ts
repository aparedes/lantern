#!/usr/bin/env bun

import { program } from "commander";
import { runCli } from "@lantern/cli-core";
import { installSignalHandlers } from "@lantern/profiler";
import { registerToolsCommand } from "./command";

installSignalHandlers();
registerToolsCommand(program);
void runCli(program);
