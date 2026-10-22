# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- No runtime checks of values whose types TypeScript already guarantees (no `typeof`/`instanceof`/`Array.isArray`/shape guards on typed parameters, typed callback results or typed declarations). Validate only at decided trust boundaries (wire input, schema-checked arguments and params).
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update the catalog definitions in `packages/ai/catalog/` instead (see its README), then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes. The generated model data in `packages/ai/src/providers/data/` is gitignored: never stage it, and don't look for it in git history.

## Chord v2 Code Style

Binding for Chord v2 (`packages/chord/src/`) and its tests, when writing and when reviewing. The model is pi-durable's source.

- Files: one concept per file, named after it; no one-helper files, no grab-bag files. First line: a comment saying what the file is for. Order: imports, exported types, then the public entry point first and its helpers below it in the order they are used; constants right above their first user. A blank line between top-level declarations. Split files by concept, never by size: one concept may take a long file (up to about 1,000 lines is fine); a second concept in a file is the reason to split.
- Functions: every export has a one-line doc comment saying what it does or guarantees. Inline comments explain a non-obvious why (cost, race, decided rule), never what the next line does. Short functions with one job (about 40 lines needs a reason; one `switch` over a tagged union is fine). No boolean flag parameters that switch behaviour: two functions or a tagged value. Never write the same lines twice. Context last: required args, then `context`/`ctx` (always required, as in Durable; optional only on error-reporting paths), then optional args.
- Types and checks: tagged unions for every state and result. Casts only where TypeScript cannot express a decided invariant, each with a short why. Every remaining runtime check names the trust boundary it serves (wire input, schema-checked params and arguments, declaration policy the types cannot express). Same-host values are plain data, immutable by convention: never copied, frozen or walked to enforce it; freeze only Chord-owned metadata when a decision says so. No defensive code against broken adapters, callers or our own modules.
- Cost and memory: no hot-path work a decision did not ask for (walks, copies, compilations, per-call allocations). The function doing counted work counts it through its context; call sites never count for others. Caches are `WeakMap`s keyed by their owner, each with a GC test; no module-level strong caches.
- Names and API: the design's vocabulary (`params`, `binding`, `principal key`), no invented synonyms; decided `ChordError` codes and reasons. Export only what a later layer or app needs. No dev or test modes, no unrequested options.
- Tests: one test file per source file, one `describe` per mechanism, the layer spec's test list case by case; cost guards through the in-memory telemetry adapter; GC tests for every cache and binding. Every slice also adds one or more runnable examples in `packages/chord/test/examples/NN-topic.ts`, one topic each, numbered across slices, written as references for Chord's users (Durable's `test/examples/` format: header with what it shows and how to run it, commented steps, printed results).
- Slices: Chord v2 is built in vertical slices (`packages/chord/docs/slices.md`). Implementers and reviewers read the slice spec, the feature map in `slices.md` and the whole of `packages/chord/docs/design.md` in full, and check the work against all three; slice specs cite design sections for orientation, not as a reading limit.
- Deferred work: anything left to a later slice goes into the section "Carry-over" of `packages/chord/docs/slices.md` under that slice, in the same change; a slice's spec and build include every entry of its section.
- Before reporting: re-read every changed file top to bottom as a stranger would; each file must be understandable without jumping around. Then `npm run check` and the layer's tests.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- `apps/p2` is outside the root check and the root tests. After p2 changes also run `cd apps/p2 && npm run check`; p2's suite is `cd apps/p2 && npm test` (TUI tests need Node 26, browser tests need `CHROMIUM_BIN`).
- Run `npm run build` whenever something needs built output (`dist/`): tests or benchmarks that import built packages, Durable's workerd suite. The full suites of Chord and Durable need it: Chord's tests that start Node processes or bundle with esbuild load workspace packages from `dist/` (the rest run from source by its vitest config), and Durable imports pi-ai's `utils/*`, which have no source export. Never use it to type check or lint: that is `npm run check`, the preferred check.
- Never run `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. It runs `packages/*` only. Otherwise run specific tests from the package root:
    - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
    - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct registry deps, including internal workspace deps, stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Writing p2 plugin code

Before writing or reviewing plugin code in `apps/p2` (server and worker facets, contracts, stores), read [apps/p2/docs/plugin-practices.md](apps/p2/docs/plugin-practices.md) in full and follow it.

## Building p2's web UI

For building or changing p2's web UI (`apps/p2`), load and follow [.pi/skills/p2-ui.md](.pi/skills/p2-ui.md).

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when the work targets a branch other than `main`

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Fork Maintenance

This checkout is `github.com/mahendrakalkura/pi`, branch `mahendra`, with upstream `github.com/earendil-works/pi` as `origin`. Every local patch lives on `mahendra`; the binary that runs on the machine is `packages/coding-agent/dist/pi`, linked from `~/.local/bin/pi`. Pi configuration and the custom extension sources live in the dotfiles repository at `~/Repositories/gitlab.kalkura.com/mahendra-kalkura/dotfiles/.pi`.

### What the fork carries

- `scripts/build-pi-binary.mjs`: `Bun.build({ compile })` wrapper used by `build:binary`. Compiles every `*.ts` under `PI_BUNDLE_EXTENSIONS` and every package pinned in `packages/coding-agent/bundle/package.json` into the binary as inline extensions. `--test <dir>` bundles a directory of `*.test.ts` files the same way and runs `bun test` on the result.
- `packages/coding-agent/src/bun/cli.ts` and `src/bun/bundled-extensions.ts`: the Bun entry passes the compiled-in extensions to `main()`; the module is empty in source and replaced at build time.
- `packages/coding-agent/bundle/`: pinned extension packages and their `node_modules`. `node_modules` must stay on disk after the build because `pi-browser-use` spawns `chrome-devtools-mcp` from it as a Node process.
- `pi-browser-use` sits in `devDependencies`, not `dependencies`, and that placement is load-bearing. `packagedExtensions()` bundles every `dependencies` entry whose `package.json` declares `pi.extensions`, and the package's own entry connects to Chrome from `session_start`, which spawns the MCP broker and fails loudly whenever no browser is listening. `devDependencies` keeps it installed for import while leaving it unbundled; `dotfiles/.pi/agent/extensions/browser-use.ts` replaces the entry and passes `lazyBrowser: true`, so the connect is deferred to the first `browser_*` call, by which point `browser.ts` has run `scripts pic`, which opens Pi's `PIC` window in the daily Chromium on port 9222 when it is missing. The wrapper reaches `dist/runtime.js`, `dist/settings.js`, and `dist/vision.js` by relative path because the package `exports` map publishes only its entry; a version bump that moves those files breaks the build loudly.
- `packages/coding-agent/bundle/patches/chrome-devtools-mcp.patch`: the bundle's `postinstall` runs `patches/apply.sh`, which applies this patch to `node_modules/chrome-devtools-mcp` after every `npm install`. Upstream emulates a focused page on every tab it discovers, which marks every tab in the daily Chromium visible while Pi is connected, so YouTube autoplays in background tabs and no tab is throttled. The patch emulates focus only on a page that `select_page` or a page-scoped tool works with. A chrome-devtools-mcp version that moves the patched lines fails `npm install` with a message naming the patch; regenerate it with `diff -ruN` against the new release.
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`: the `/model` picker shows only `settings.enabledModels`, disables the all/scoped Tab toggle, renders a box-drawn `cli-table3` table (`Client | Provider | Model | Name | Default`) sorted by client, provider, then model, windowed to the rows the terminal can show with the selection kept in view, and hides the row counter, selected model name, and successful refresh notice. Refresh failures remain visible.
- `packages/coding-agent/package.json` carries `cli-table3`, shared by the selector and the custom `accounts` extension.

### Weekly sync and rebuild

Run from the checkout root. Stop at the first failing step; nothing after it is safe to skip.

```bash
cd ~/Repositories/github.com/earendil-works/pi
DOTFILES=~/Repositories/gitlab.kalkura.com/mahendra-kalkura/dotfiles

# 1. Fetch upstream and rebase the patch series onto it. rerere replays earlier conflict resolutions.
#    Upstream owns the rest of this AGENTS.md; when upstream edits it, the rebase conflicts at the
#    appended "Fork Maintenance" section. Resolve by keeping both sides; rerere replays that thereafter.
#    `--multiple` is required: `git fetch origin fork` reads `fork` as a refspec on `origin`, fails with
#    "couldn't find remote ref fork", and fetches nothing, so the rebase below silently becomes a no-op.
git fetch --multiple origin fork
git switch mahendra
git rebase origin/main
# On a conflict: fix, `git add`, `git rebase --continue`. To abandon: `git rebase --abort`.

# 2. Dependencies and generated model data (both change with upstream).
#    `package-lock.json` conflicts are resolved by taking upstream and regenerating afterwards with
#    `npm install --package-lock-only --ignore-scripts`; never hand-merge lockfile hunks.
#    `hydrate:model-data` fails with "Cannot hydrate missing providers: <id>" when models.dev stops
#    serving a catalog the committed shards still import. Do not delete the provider: `src/providers/data/`
#    is gitignored, so the tree cannot be repaired locally, and upstream restores it within a release.
#    Rebase onto a newer origin/main first, which is what actually clears it.
mise exec node@24 -- npm install --ignore-scripts
mise exec node@24 -- npm run hydrate:model-data

# 3. Upstream gate. Any failure here is either an upstream regression or a patch that needs updating.
#    `check:ts-imports` walks every directory except `.git`, `coverage`, `dist`, and `node_modules`, so the
#    previous build's `.local-extensions/` copy of `browser-use.ts` trips it on its deliberate relative
#    `../node_modules/pi-browser-use/dist/*.js` imports. Step 4 recreates the directory, so remove it first.
gio trash packages/coding-agent/bundle/.local-extensions 2>/dev/null || true
mise exec node@24 -- npm exec -- biome check --error-on-warnings .
mise exec node@24 -- npm run check:pinned-deps
mise exec node@24 -- npm run check:runtime-deps
mise exec node@24 -- npm run check:ts-imports
mise exec node@24 -- npm run check:entry-graphs
mise exec node@24 -- npm run check:install-lock:coding-agent
mise exec node@24 -- npm exec -- tsc --noEmit
mise exec node@24 -- npm run check:browser-smoke
# Child-process tests such as 2791-fswatch-error-crash import `@earendil-works/pi-tui` through its
# `dist/`, so a stale build fails them with a missing-export SyntaxError. Rebuild it first.
# The experimental durable tests import `@earendil-works/pi-durable/tools` the same way and fail with
# "Cannot find package" on a stale `packages/durable/dist`.
mise exec node@24 -- npm --prefix packages/tui run build
# pi-durable imports `@earendil-works/pi-codemode/portable` and `@earendil-works/pi-ai` through their `dist/`,
# so its build fails with TS2307 "Cannot find module" or TS2353 on a stale `packages/codemode/dist` or
# `packages/ai/dist`. Chord imports `@earendil-works/pi-telemetry` the same way and fails with TS2305 on a stale
# `packages/telemetry/dist`. Build telemetry, chord, codemode, and ai first, in the root `build` script order.
mise exec node@24 -- npm --prefix packages/telemetry run build
mise exec node@24 -- npm --prefix packages/chord run build
mise exec node@24 -- npm --prefix packages/codemode run build
mise exec node@24 -- npm --prefix packages/ai run build:offline
mise exec node@24 -- npm --prefix packages/durable run build
# The pi-env tests spawn the Rust daemon and fail with "Build the daemon first" when
# `packages/env/daemon/target/debug/pi-env` is missing. CI builds it the same way before `npm test`.
mise exec node@24 -- npm run build:daemon --workspace packages/env
env -i PATH="$PATH" HOME="$HOME" mise exec node@24 -- bash ./test.sh
# test.sh must not see the provider API keys the Fish shell exports: with keys present, Pi's
# test harness sees hundreds of available models and the selector tests assert on a short list.
# Always run the pi-env SSH tests under bash, never under the account shell. The test sshd starts the
# daemon through the account's login shell, which is fish on both machines, and fish rejects the
# `exec "$SHELL" -lc 'exec "$0" "$@"'` in `launchCommand`, so "starts the daemon through the login shell
# only when asked" exits 127 inside test.sh. That one failure in test.sh is expected; the bash run below
# is authoritative for `packages/env/test/ssh.test.ts`, and every other test.sh failure still stops the sync.
(cd packages/env \
    && sed 's|`SetEnv HOME=${home}`|`SetEnv HOME=${home} SHELL=/bin/bash`|' test/ssh.test.ts > test/ssh-bash.scratch.test.ts \
    && env -i PATH="$PATH" HOME="$HOME" mise exec node@24 -- node ../../node_modules/vitest/dist/cli.js --run test/ssh-bash.scratch.test.ts; \
    status=$?; rm -f test/ssh-bash.scratch.test.ts; exit $status)

# 4. Extension packages, then the binary with the dotfiles extensions compiled in.
(cd packages/coding-agent/bundle && mise exec node@24 -- npm install --no-audit --no-fund)
#    `build:binary` does not build `pi-codemode` or `pi-mcp`, and `tsc` in coding-agent fails on their
#    missing `dist/` without these lines. Chord needs a fresh `packages/telemetry/dist` first.
mise exec node@24 -- npm --prefix packages/telemetry run build
mise exec node@24 -- npm --prefix packages/chord run build
mise exec node@24 -- npm --prefix packages/codemode run build
mise exec node@24 -- npm --prefix packages/mcp run build
PI_BUNDLE_EXTENSIONS="$DOTFILES/.pi/agent/extensions" mise exec node@24 -- npm --prefix packages/coding-agent run build:binary
packages/coding-agent/dist/pi --version

# 5. Extension tests against the modules the binary contains, then a smoke run.
(cd packages/coding-agent && bun ../../scripts/build-pi-binary.mjs --test "$DOTFILES/.pi/tests")
(cd /tmp && PI_TIMING=1 pi -p "reply ok" --model nr-deepseek/deepseek-flash --thinking off)

# 6. Publish the rebased branch. The rebase rewrote history, so a lease-protected force push is required.
git push --force-with-lease fork mahendra
```

`~/.local/bin/pi` already points at `packages/coding-agent/dist/pi`, so the new binary is live as soon as step 4 finishes; there is nothing to relink.

### Bumping an extension package

Edit the version in `packages/coding-agent/bundle/package.json`, then run steps 4 and 5 and commit `package.json` and `package-lock.json`. A package that stops working inside the binary (typically one that resolves files through `import.meta.url` at import time) is replaced by a custom extension under `dotfiles/.pi/agent/extensions/` rather than patched here.

### Changing a custom extension

Edit under `dotfiles/.pi/agent/extensions/`, run steps 4 (the `build:binary` line only) and 5, and commit in dotfiles. Third-party imports a custom extension needs are declared in `packages/coding-agent/bundle/package.json`.

### Bringing a patch back to upstream

Rebase interactively to isolate the commit, `git switch -c <topic> origin/main`, `git cherry-pick <sha>`, push the topic branch to `fork`, and open the pull request against `earendil-works/pi`. When it merges, the next weekly rebase drops the local copy automatically.
