#!/usr/bin/env bun
/**
 * Attributes the bytes of a Vite (rolldown) production bundle to the packages they come from,
 * using the bundle's source map. `source-map-explorer` cannot read rolldown's maps (they end
 * lines with an `Infinity` column), hence this small decoder.
 *
 * Usage, from the repo root:
 *
 *   bun run --filter @lantern/measure build -- --sourcemap
 *   bun scripts/analyze-bundle.ts packages/commands/measure/dist/assets/index-*.js.map
 *
 *   bun run --filter @lantern/web-reporter build -- --sourcemap
 *   bun scripts/analyze-bundle.ts packages/commands/report/dist/index-*.js.map packages/commands/report/dist/index.html
 *
 * The second argument is the generated file the map describes; when the bundle was inlined in
 * an HTML file (the report), pass that file and the script is extracted from it. Sizes are
 * minified bytes (not gzipped); the last mapping segment of a line is sized up to the line end.
 * Run `bun run build` afterwards to get rid of the `.map` files.
 */
import fs from "fs";
import path from "path";
import { decode } from "@jridgewell/sourcemap-codec";

const [mapPath, generatedPathArg] = process.argv.slice(2);
if (!mapPath) {
  console.error("Usage: bun scripts/analyze-bundle.ts <bundle.js.map> [generated.js | index.html]");
  process.exit(1);
}

const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as {
  sources: string[];
  mappings: string;
};

const generatedPath = generatedPathArg ?? mapPath.replace(/\.map$/, "");
let generated = fs.readFileSync(generatedPath, "utf8");
if (generatedPath.endsWith(".html")) {
  const match = generated.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`No inlined module script found in ${generatedPath}`);
  generated = match[1];
}
const lines = generated.split("\n");

const packageOf = (source: string): string => {
  const normalized = source.replace(/\\/g, "/");
  const nodeModules = normalized.lastIndexOf("node_modules/");
  if (nodeModules !== -1) {
    const rest = normalized.slice(nodeModules + "node_modules/".length);
    const [first, second] = rest.split("/");
    return first.startsWith("@") ? `${first}/${second}` : first;
  }
  if (normalized.startsWith("\0") || normalized.includes("vite/")) return "(vite runtime)";
  // App code: keep the workspace package directory.
  const packages = normalized.indexOf("packages/");
  if (packages !== -1) {
    return normalized.slice(packages).split("/").slice(0, 3).join("/");
  }
  return path.dirname(normalized);
};

const bytesPerSource = new Map<string, number>();
let unmapped = 0;
const decoded = decode(map.mappings);

decoded.forEach((segments, lineIndex) => {
  const lineLength = lines[lineIndex]?.length ?? 0;
  segments.forEach((segment, index) => {
    const start = Math.min(segment[0], lineLength);
    const next = segments[index + 1]?.[0] ?? lineLength;
    const size = Math.max(0, Math.min(next, lineLength) - start);
    if (segment.length === 1) {
      unmapped += size;
      return;
    }
    const source = map.sources[segment[1]] ?? "(unknown)";
    bytesPerSource.set(source, (bytesPerSource.get(source) ?? 0) + size);
  });
  // Bytes before the first segment of a line have no origin.
  const first = segments[0]?.[0] ?? lineLength;
  unmapped += Math.min(first, lineLength);
});

const bytesPerPackage = new Map<string, number>();
for (const [source, bytes] of bytesPerSource) {
  const pkg = packageOf(source);
  bytesPerPackage.set(pkg, (bytesPerPackage.get(pkg) ?? 0) + bytes);
}

const total = generated.length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
const pct = (bytes: number) => `${((bytes / total) * 100).toFixed(1)}%`;

console.log(`Bundle: ${generatedPath} (${kb(total)})\n`);
const rows = [...bytesPerPackage.entries()].sort((a, b) => b[1] - a[1]);
for (const [pkg, bytes] of rows) {
  console.log(`${kb(bytes).padStart(10)}  ${pct(bytes).padStart(6)}  ${pkg}`);
}
console.log(`${kb(unmapped).padStart(10)}  ${pct(unmapped).padStart(6)}  (unmapped)`);
