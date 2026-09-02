import { AppInfo } from "@lantern/types";
import { adb } from "./adb";

export const parsePackageList = (output: string): AppInfo[] =>
  output
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice("package:".length))
    .sort()
    .map((bundleId) => ({ bundleId, name: bundleId }));

/** Third-party packages only (`-3`); system apps are rarely what someone wants to measure. */
export const listInstalledApps = async (serial?: string): Promise<AppInfo[]> =>
  parsePackageList(adb(["shell", "pm", "list", "packages", "-3"], { serial }));
