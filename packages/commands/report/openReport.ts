#!/usr/bin/env bun

import { program } from "commander";
import { runCli } from "@lantern/cli-core";
import { registerReportCommand } from "./command";

registerReportCommand(program);
void runCli(program);
