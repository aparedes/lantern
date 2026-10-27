#!/usr/bin/env bun

import { runCli } from "@lantern/cli-core";
import { installSignalHandlers } from "@lantern/profiler";
import { createProgram } from "./cli";

installSignalHandlers();
void runCli(createProgram());
