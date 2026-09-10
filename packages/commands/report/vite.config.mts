import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  // The HTML entry lives next to the app sources.
  root: "src",
  resolve: {
    alias: {
      // Same for the types and logger packages, which the reporter source (aliased below)
      // imports by name: the dev server cannot destructure named exports from their CommonJS `dist`.
      "@lantern/types": fileURLToPath(new URL("../../core/types/index.ts", import.meta.url)),
      "@lantern/logger": fileURLToPath(new URL("../../core/logger/index.ts", import.meta.url)),
      // Bundle the shared UI library from source instead of its tsc-built CJS `dist`, so the
      // React Compiler (and Fast Refresh) actually see its components — `dist` ships JSX
      // already lowered to `jsx()` calls, which the compiler skips.
      "@lantern/web-reporter-ui": fileURLToPath(
        new URL("../../core/web-reporter-ui/index.tsx", import.meta.url)
      ),
      // Same for the reporter: its CJS `dist` `require`s es-toolkit's CJS build, which cannot be
      // tree-shaken and costs ~50 kB; from source the ESM build shrinks to the few helpers used.
      "@lantern/reporter": fileURLToPath(new URL("../../core/reporter/index.ts", import.meta.url)),
    },
  },
  // Relative asset URLs so the report works when opened from the filesystem.
  base: "./",
  plugins: [
    // React Compiler on, via oxc's native Rust port (`oxc-transform-react`) — no Babel
    // in the pipeline. It emits `react/compiler-runtime` imports, which need React >= 19.
    react({ compiler: true }),
    // Tailwind v4 is configured entirely from `web-reporter-ui/index.css` — no PostCSS,
    // no JS config.
    tailwindcss(),
    // The report is distributed as a single self-contained HTML file.
    viteSingleFile(),
  ],
  build: {
    // `tsc --build` emits the CLI files (openReport.js, writeReport.js, ...) into the
    // same dist folder, so this build must never empty it.
    outDir: "../dist",
    emptyOutDir: false,
  },
});
