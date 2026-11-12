#!/usr/bin/env bun

/**
 * Builds a standalone macOS executable of the lantern CLI.
 *
 * Only Apple Silicon (arm64) is built: Apple has retired Intel Macs from macOS support and the
 * project has no Intel machine to build or test on.
 *
 * Usage:
 *   bun run build:standalone
 *   bun run build:standalone --sign "Developer ID Application: ..."
 *   bun run build:standalone --sign "Developer ID Application: ..." --notarize <keychain-profile>
 *   bun run build:standalone --skip-build
 *
 * `--notarize` takes a notarytool keychain profile, created once with
 * `xcrun notarytool store-credentials <profile>`.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_SRC = path.join(REPO_ROOT, "packages/commands/lantern/src");
const GENERATED_FILE = path.join(CLI_SRC, "embedded.generated.ts");

const TARGET = "bun-darwin-arm64";

const fail = (message: string): never => {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
};

// --- Argument parsing -------------------------------------------------------

const parseArgs = () => {
  const args = process.argv.slice(2);
  let sign: string | undefined;
  let notarize: string | undefined;
  let outfile: string | undefined;
  let skipBuild = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = () => {
      const value = args[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--sign":
        sign = nextArg();
        break;
      case "--notarize":
        notarize = nextArg();
        break;
      case "--outfile":
        outfile = nextArg();
        break;
      case "--skip-build":
        skipBuild = true;
        break;
      default:
        fail(`Unknown argument "${arg}"`);
    }
  }

  const signIdentity = sign ?? process.env.LANTERN_CODESIGN_IDENTITY ?? "-";
  const notaryProfile = notarize ?? process.env.LANTERN_NOTARY_PROFILE;
  if (notaryProfile && signIdentity === "-") {
    fail("--notarize needs a Developer ID signing identity (--sign or LANTERN_CODESIGN_IDENTITY)");
  }

  return {
    skipBuild,
    signIdentity,
    notaryProfile,
    outfile: outfile ?? path.join(REPO_ROOT, "build/standalone/lantern"),
  };
};

const options = parseArgs();

// --- Helpers ----------------------------------------------------------------

const run = (command: string[], errorMessage: string) => {
  console.log(`\n$ ${command.join(" ")}`);
  const result = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) fail(`${errorMessage} (exit code ${result.exitCode})`);
};

// --- Step 1: build the workspace --------------------------------------------

if (options.skipBuild) {
  console.log("⏭  Skipping `bun run build` (--skip-build)");
} else {
  run(["bun", "run", "build"], "`bun run build` failed");
}

// --- Step 2: collect assets to embed ----------------------------------------

type AssetGroup = "profiler" | "ios-profiler" | "report" | "webapp";
const ASSET_GROUPS: readonly AssetGroup[] = ["profiler", "ios-profiler", "report", "webapp"];
interface Asset {
  group: AssetGroup;
  name: string;
  sourcePath: string;
}

const WEB_ASSET_EXTENSIONS = [".html", ".js", ".css"];
const EXCLUDED_EXTENSIONS = [".map", ".d.ts", ".tsbuildinfo"];
/** `tsc` emits these next to the bundler output — they are Node modules, not web assets. */
const EXCLUDED_NAMES = ["openReport.js", "writeReport.js", "command.js"];
/**
 * Vite emits hashed chunks into `assets/` for the measure webapp (the report is a single
 * self-contained `index.html`). Everything else in these dist folders is `tsc` output.
 */
const NESTED_ASSET_DIRS = ["assets"];

const listFilesIn = (dir: string) => {
  if (!fs.existsSync(dir)) fail(`Expected directory does not exist: ${dir}`);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
};

const collectWebAssets = (group: AssetGroup, dir: string): Asset[] => {
  const isWebAsset = (baseDir: string, name: string) =>
    WEB_ASSET_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
    !EXCLUDED_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
    !EXCLUDED_NAMES.includes(name) &&
    // Anything `tsc` emitted has a sibling declaration file — those are never web assets.
    !fs.existsSync(path.join(baseDir, `${name.replace(/\.js$/, "")}.d.ts`));

  const topLevel = listFilesIn(dir)
    .filter((name) => isWebAsset(dir, name))
    .map((name) => ({ group, name, sourcePath: path.join(dir, name) }));

  const nested = NESTED_ASSET_DIRS.filter((subDir) =>
    fs.existsSync(path.join(dir, subDir))
  ).flatMap((subDir) =>
    listFilesIn(path.join(dir, subDir))
      .filter((name) => isWebAsset(path.join(dir, subDir), name))
      // The name doubles as the path the standalone binary materializes the asset at, so keep
      // the `assets/` prefix — `index.html` references chunks as `./assets/<name>`.
      .map((name) => ({
        group,
        name: `${subDir}/${name}`,
        sourcePath: path.join(dir, subDir, name),
      }))
  );

  return [...topLevel, ...nested];
};

const profilerBinDir = path.join(REPO_ROOT, "packages/platforms/android/rust-profiler/bin");
const iosProfilerBinDir = path.join(REPO_ROOT, "packages/platforms/ios/rust-profiler/bin");
const reportDistDir = path.join(REPO_ROOT, "packages/commands/report/dist");
const webappDistDir = path.join(REPO_ROOT, "packages/commands/measure/dist");

// The iOS profiler runs on the Mac itself: the committed arm64 binary is embedded under the
// same name the `@lantern/ios` package resolves at runtime.
const IOS_PROFILER_BINARY = "lantern-ios-profiler";
const iosProfilerSource = path.join(iosProfilerBinDir, IOS_PROFILER_BINARY);
if (!fs.existsSync(iosProfilerSource)) {
  fail(
    `Missing ${path.relative(REPO_ROOT, iosProfilerSource)}. Build it with packages/platforms/ios/rust-profiler/build_macos.sh (macOS only).`
  );
}

const assets: Asset[] = [
  ...listFilesIn(profilerBinDir).map((name) => ({
    group: "profiler" as const,
    name,
    sourcePath: path.join(profilerBinDir, name),
  })),
  { group: "ios-profiler", name: IOS_PROFILER_BINARY, sourcePath: iosProfilerSource },
  ...collectWebAssets("report", reportDistDir),
  ...collectWebAssets("webapp", webappDistDir),
];

const assetsIn = (group: AssetGroup) => assets.filter((asset) => asset.group === group);

for (const group of ASSET_GROUPS) {
  if (assetsIn(group).length === 0) {
    fail(`No assets found for group "${group}". Did \`bun run build\` succeed?`);
  }
}

for (const group of ["report", "webapp"] as const) {
  if (!assetsIn(group).some((asset) => asset.name === "index.html")) {
    fail(`Group "${group}" is missing an index.html. Did the Vite build run?`);
  }
}

console.log("\n📦 Embedding assets:");
for (const group of ASSET_GROUPS) {
  console.log(
    `  ${group}: ${assetsIn(group)
      .map((asset) => asset.name)
      .join(", ")}`
  );
}

// --- Step 3: generate embedded.generated.ts ---------------------------------

const toImportSpecifier = (sourcePath: string) => {
  const relative = path.relative(CLI_SRC, sourcePath);
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const imports = assets
  .map(
    (asset, index) =>
      `import asset${index} from "${toImportSpecifier(asset.sourcePath)}" with { type: "file" };`
  )
  .join("\n");

const entries = assets
  .map(
    (asset, index) =>
      `  { group: "${asset.group}", name: ${JSON.stringify(asset.name)}, path: asset${index} },`
  )
  .join("\n");

// Identifies this exact set of embedded files. The binary materializes them into a temp folder
// named after it, so two builds of the same version never share (and never go stale in) one
// folder: the webapp's `index.html` is the same size in every build — only the chunk hashes it
// references change — so no size check could tell an old copy from a new one.
const buildIdHash = new Bun.CryptoHasher("sha256");
for (const asset of assets) {
  buildIdHash.update(`${asset.group}/${asset.name}\0`);
  buildIdHash.update(fs.readFileSync(asset.sourcePath));
}
const buildId = buildIdHash.digest("hex").slice(0, 12);

const generated = `// GENERATED by scripts/build-standalone.ts — do not edit or commit
${imports}

export const EMBEDDED_BUILD_ID = ${JSON.stringify(buildId)};

export const EMBEDDED_ASSETS: { group: ${ASSET_GROUPS.map((group) => JSON.stringify(group)).join(" | ")}; name: string; path: string }[] = [
${entries}
];
`;

fs.writeFileSync(GENERATED_FILE, generated);
console.log(`\n📝 Wrote ${path.relative(REPO_ROOT, GENERATED_FILE)} (${assets.length} assets)`);

// --- Step 4: compile --------------------------------------------------------

fs.mkdirSync(path.dirname(options.outfile), { recursive: true });

run(
  [
    "bun",
    "build",
    "--compile",
    // ESM output (the default) is required: ink >= 4 uses top-level await, which cannot be
    // lowered to CJS. The old `--format=cjs` workaround for ink 3's yoga-layout-prebuilt
    // asm.js is obsolete — ink 7 ships WASM yoga.
    `--target=${TARGET}`,
    // Without [dir], the two index.html files (report + webapp) collide into one asset
    "--asset-naming=[dir]/[name].[ext]",
    // ink 7.1 lazily `import()`s its devtools module, which statically imports the optional
    // peer `react-devtools-core` (16 MB, deliberately not installed). The bundler follows the
    // dynamic import and fails to resolve the package — and marking *the package* external
    // doesn't help, since the inlined module's import gets hoisted and evaluated at startup.
    // Leaving ink's devtools module itself external keeps the `import()` dynamic; ink only
    // takes that path when DEV=true *and* `react-devtools-core` resolves, never in the binary.
    "--external",
    "*/devtools.js",
    "packages/commands/lantern/src/standalone.ts",
    "--outfile",
    options.outfile,
  ],
  "`bun build --compile` failed"
);

// --- Step 5: code signing ---------------------------------------------------

// bun 1.4.0 emits an invalid ad-hoc signature, which makes macOS SIGKILL the binary on launch,
// so the binary is always re-signed. A real identity additionally gets what notarization
// requires: the hardened runtime, a secure timestamp, and the JIT entitlements JavaScriptCore
// needs to run under the hardened runtime.
const isAdHoc = options.signIdentity === "-";
run(
  [
    "codesign",
    "--sign",
    options.signIdentity,
    "--force",
    ...(isAdHoc
      ? []
      : [
          "--options",
          "runtime",
          "--timestamp",
          "--entitlements",
          path.join(import.meta.dir, "entitlements.plist"),
        ]),
    options.outfile,
  ],
  "codesign failed to sign the binary"
);
run(
  ["codesign", "--verify", "--strict", "--verbose=2", options.outfile],
  "codesign verification of the binary failed"
);

// --- Step 5b: notarization --------------------------------------------------

// notarytool only accepts zip/pkg/dmg uploads, and a bare Mach-O cannot be stapled: Gatekeeper
// looks the ticket up online on first launch. The zip is therefore both the upload and the
// artifact to distribute.
let notarizedZip: string | undefined;
if (options.notaryProfile) {
  notarizedZip = `${options.outfile}.zip`;
  fs.rmSync(notarizedZip, { force: true });
  run(
    // No --keepParent: for a single file it would wrap the binary in its parent folder.
    // --norsrc keeps local xattrs (e.g. com.apple.provenance) out as a stray `._` entry; the
    // signature is embedded in the Mach-O, so nothing needed is lost.
    ["ditto", "-c", "-k", "--norsrc", options.outfile, notarizedZip],
    "failed to zip the binary for notarization"
  );
  run(
    [
      "xcrun",
      "notarytool",
      "submit",
      notarizedZip,
      "--keychain-profile",
      options.notaryProfile,
      "--wait",
    ],
    "notarization failed (inspect with `xcrun notarytool log <submission-id> --keychain-profile <profile>`)"
  );
}

// --- Step 6: report ---------------------------------------------------------

const sizeMb = fs.statSync(options.outfile).size / 1024 / 1024;
const fileOutput = Bun.spawnSync(["file", options.outfile]).stdout.toString().trim();

console.log(`\n✅ Built ${path.relative(REPO_ROOT, options.outfile)}`);
if (notarizedZip) console.log(`   notarized: ${path.relative(REPO_ROOT, notarizedZip)}`);
console.log(`   size: ${sizeMb.toFixed(1)} MB`);
console.log(`   file: ${fileOutput}`);
