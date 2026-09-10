# Contributing

## Commit naming

We use [conventional changelogs](https://www.conventionalcommits.org/en/v1.0.0-beta.4/#summary) for commits and PR names

It should be like:

```
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

- [ ] with type = feat/fix/refactor/chore/docs/test/…
- [ ] description should be lowercase and start with a verb

Here are some examples https://www.conventionalcommits.org/en/v1.0.0-beta.4/#examples

## Linting and formatting

We use [oxlint](https://oxc.rs/docs/guide/usage/linter.html) for linting and [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) for formatting.

- `bun run lint` / `bun run lint:fix` — run oxlint (the `correctness` category plus the extra rules configured in `.oxlintrc.json`), optionally auto-fixing what it can.
- `bun run format` / `bun run format:check` — run oxfmt, which produces Prettier-compatible output, either rewriting files in place or just checking them.

For a one-off exception, disable the specific rule on the next line with `// oxlint-disable-next-line <rule>` rather than disabling a whole file.

Note that `react/refs` and `react/set-state-in-effect` are intentionally disabled in `.oxlintrc.json` — they are React-Compiler-era rules that ESLint never enforced in this codebase.

## Tests

We use [`bun test`](https://bun.com/docs/cli/test) as the test runner. Tests are split into two
groups, because the DOM group needs a `happy-dom` global registration that the node group must not
have:

- `bun run test:unit` — runs both groups.
- `bun run test:unit:node` — node-environment tests (preloads `test-setup/node.ts`).
- `bun run test:unit:dom` — DOM-environment tests (preloads `test-setup/dom.tsx`). Append
  `--update-snapshots` to refresh the snapshots.

Test files must be named `*.test.ts` / `*.test.tsx` — `bun test` only discovers those.

### No implicit globals

Unlike Jest, `bun test` does not inject globals. Every test file must explicitly import everything
it uses from `bun:test`:

```ts
import { describe, it, expect, beforeAll, afterAll, jest, spyOn, mock } from "bun:test";
```

### Mocking

Two rules cover almost every case:

- **Same-package source under test** (bun transpiles it fresh from TypeScript): spy on a namespace
  import of the module.

  ```ts
  import * as shell from "../shell";
  spyOn(shell, "executeCommand").mockImplementation(() => "output");
  ```

- **Code reached through another workspace package's compiled `dist/`** (CommonJS output): spy on
  the CommonJS module object that the `dist` code actually holds a reference to.

  ```ts
  import type * as childProcess from "child_process";
  spyOn(require("child_process") as typeof childProcess, "execSync").mockImplementation(mock);
  ```

  A namespace-import spy does _not_ work in this case — the ESM namespace and the CommonJS module
  object are different objects.

Spying on a method of an exported object (`profiler.installProfilerOnDevice`, `fs.promises.readFile`,
`Logger.debug`, …) works for every consumer regardless of import style.

Note that all files in a single `bun test` invocation share one module cache and one process, so
spies leak between files: a file that creates spies at module level should end with
`afterAll(() => mock.restore());`. `mock.module()` is _not_ undone by `mock.restore()`, so prefer
`spyOn` unless you really need to replace a whole module.

## Running `lantern` commands locally

Start by building the whole project:

At the root of the repo:

```
bun install
bun run watch
```

Keep this open in one terminal.

### `measure` command

Start the webapp with

```bash
bun run --filter @lantern/measure start
```

Then run the `measure` commmand with:

```bash
DEVELOPMENT_MODE=true bun packages/commands/measure/dist/server/bin.js measure
```

Pass `--platform android|ios` (or set `PLATFORM=ios` in the environment) to
pick a platform explicitly; it's otherwise auto-detected when only one kind
of device is connected. When several devices of that platform are connected,
pick one with `--device <serial|udid>` (an adb serial on Android, a UDID on
iOS); `--logLevel <silent|error|warn|success|info|debug|trace>` controls the
verbosity. These three options are shared by `test`, `measure` and
`tools get_bundle_id` (see `registerCommonOptions` in `@lantern/profiler`).

### `test` command

To run the command locally:

```
bun packages/commands/test/dist/bin.js test
```

This command is the equivalent of

```
lantern test
```

`test` also accepts `--platform`, `--device` and `--logLevel` (or the
`PLATFORM` env var), the same as `measure`.

### `tools` command

To run the command locally:

```
bun packages/commands/tools/dist/bin.js tools
```

This command is the equivalent of

```
lantern tools
```

`tools get_bundle_id` takes the same `--platform`, `--device` and `--logLevel`
options as `measure` and `test`.

### web-reporter

Run in another terminal:

```
bun run --filter @lantern/web-reporter start
```

Then in `packages/commands/report/src/App.tsx`, uncomment the lines to add your own measures:

```ts
// Uncomment with when locally testing
testCaseResults = [require("../measures.json")];
```

You should now be able to open [the local server](http://localhost:1234/)

Run `bun run test:unit:dom --update-snapshots` after modifications.

## Building the standalone macOS binary

`bun run build:standalone` builds a self-contained `lantern` executable for arm64 (Apple
Silicon) into `build/standalone/lantern-macos-arm64`. The binary is ad-hoc signed, which is
fine for local use but will not pass Gatekeeper on another machine.

```
bun run build:standalone
```

To produce a distributable, properly signed binary, pass your signing identity (the
`LANTERN_CODESIGN_IDENTITY` env var works as a fallback):

```
bun run build:standalone --sign "Developer ID Application: Your Name (TEAMID)"
```

Only Apple Silicon (arm64) is built: Apple has retired Intel Macs from macOS support and the
project has no Intel machine to build or test on.

Other flags: `--skip-build` reuses the existing `dist/` output instead of re-running
`bun run build`, and `--outfile <path>` overrides the output location.

The executable embeds the Android `rust-profiler` binary (arm64-v8a — devices and the Apple
Silicon emulator), the iOS profiler binary
(`packages/platforms/ios/rust-profiler/bin/lantern-ios-profiler`, rebuilt with `build_macos.sh`) and both web apps
(the `report` web reporter and the `measure` live webapp). On the first run of a given version,
they are extracted to `$TMPDIR/lantern-<version>-assets` so that the regular folder-based
lookups (and `adb push`) see real file paths.

### iOS profiler binary

After changing the `packages/platforms/ios/rust-profiler` crate, rebuild the committed
binary with:

```
packages/platforms/ios/rust-profiler/build_macos.sh
```

This writes `rust-profiler/bin/lantern-ios-profiler` (arm64 only); commit it together with
the crate change that motivated it. `LANTERN_IOS_BINARY_PATH` overrides the binary
`@lantern/ios` spawns, which is useful for testing a build from elsewhere. Set
`LANTERN_IOS_DEBUG=1` for verbose protocol logs on stderr. A macOS CI job rebuilds the
binary from source on every push to catch a crate/binary mismatch.

### Android profiler binary

After changing the `packages/platforms/android/rust-profiler` crate, rebuild the committed
device binary with:

```
packages/platforms/android/rust-profiler/build_all_abi.sh
```

Builds are fully static musl binaries linked with Rust's bundled `rust-lld`, so no Android
NDK (or any C toolchain) is required — only the relevant `rustup` targets. Only
`bin/lantern-android-profiler-arm64-v8a` is shipped (real devices and the Apple Silicon
emulator); commit it together with the crate change that motivated it.

### Iterating without a full compile

Compiling takes a while. To run the aggregated CLI straight from the workspace `dist/` output
after a `bun run build`:

```
bun run lantern -- <command>
```
