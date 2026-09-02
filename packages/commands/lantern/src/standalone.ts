import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "@lantern/logger";
import { installSignalHandlers } from "@lantern/profiler";
import { EMBEDDED_ASSETS } from "./embedded.generated";
import { version } from "../package.json";
import { createProgram } from "./cli";

// Embedded files live on bun's virtual filesystem; materialize them once per version so the
// existing folder-based lookups (and `adb push`) see real paths.
const assetsRoot = path.join(os.tmpdir(), `lantern-${version}-assets`);
for (const asset of EMBEDDED_ASSETS) {
  // `asset.name` can be nested (Vite emits the webapp chunks into `assets/`).
  const destination = path.join(assetsRoot, asset.group, asset.name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const source = fs.statSync(asset.path);
  if (!fs.existsSync(destination) || fs.statSync(destination).size !== source.size) {
    fs.writeFileSync(destination, fs.readFileSync(asset.path)); // copyFileSync cannot read /$bunfs paths
    // The Android profiler is `adb push`ed, but the iOS one executes on this Mac.
    if (asset.group === "ios-profiler") fs.chmodSync(destination, 0o755);
  }
}
process.env.LANTERN_BINARY_PATH ??= path.join(assetsRoot, "profiler");
process.env.LANTERN_IOS_BINARY_PATH ??= path.join(
  assetsRoot,
  "ios-profiler",
  "lantern-ios-profiler"
);
process.env.LANTERN_REPORT_ASSETS_PATH ??= path.join(assetsRoot, "report");
process.env.LANTERN_WEBAPP_PATH ??= path.join(assetsRoot, "webapp");

installSignalHandlers();
createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    Logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
