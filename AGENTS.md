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
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
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

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

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
- `pi-browser-use` sits in `devDependencies`, not `dependencies`, and that placement is load-bearing. `packagedExtensions()` bundles every `dependencies` entry whose `package.json` declares `pi.extensions`, and the package's own entry connects to Chrome from `session_start`, which spawns the MCP broker and fails loudly whenever no browser is listening. `devDependencies` keeps it installed for import while leaving it unbundled; `dotfiles/.pi/agent/extensions/browser-use.ts` replaces the entry and passes `lazyBrowser: true`, so the connect is deferred to the first `browser_*` call, by which point `browser.ts` has launched the approved profile. The wrapper reaches `dist/runtime.js`, `dist/settings.js`, and `dist/vision.js` by relative path because the package `exports` map publishes only its entry; a version bump that moves those files breaks the build loudly.
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`: the `/model` picker shows only `settings.enabledModels`, disables the all/scoped Tab toggle, renders a box-drawn `cli-table3` table (`Client | Provider | Model | Name | Default`) sorted by client, provider, then model, windowed to the rows the terminal can show with the selection kept in view, and hides the row counter, selected model name, and successful refresh notice. Refresh failures remain visible.
- `packages/coding-agent/package.json` carries `cli-table3`, shared by the selector and the custom `accounts` extension.
- `packages/ai/src/api/google-shared.ts`: `FinishReason.TOO_MANY_TOOL_CALLS` case, needed for `tsgo --noEmit` with `@google/genai` 2.21.0.

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
mise exec node@24 -- npm exec -- biome check --error-on-warnings .
mise exec node@24 -- npm run check:pinned-deps
mise exec node@24 -- npm run check:runtime-deps
mise exec node@24 -- npm run check:ts-imports
mise exec node@24 -- npm run check:entry-graphs
mise exec node@24 -- npm run check:shrinkwrap
mise exec node@24 -- npm run check:install-lock:coding-agent
mise exec node@24 -- npm exec -- tsgo --noEmit
mise exec node@24 -- npm run check:browser-smoke
env -i PATH="$PATH" HOME="$HOME" mise exec node@24 -- bash ./test.sh
# test.sh must not see the provider API keys the Fish shell exports: with keys present, Pi's
# test harness sees hundreds of available models and the selector tests assert on a short list.

# 4. Extension packages, then the binary with the dotfiles extensions compiled in.
(cd packages/coding-agent/bundle && mise exec node@24 -- npm install --no-audit --no-fund)
mise exec node@24 -- npm --prefix packages/chord run build
PI_BUNDLE_EXTENSIONS="$DOTFILES/.pi/agent/extensions" mise exec node@24 -- npm --prefix packages/coding-agent run build:binary
packages/coding-agent/dist/pi --version

# 5. Extension tests against the modules the binary contains, then a smoke run.
(cd packages/coding-agent && bun ../../scripts/build-pi-binary.mjs --test "$DOTFILES/.pi/tests")
(cd /tmp && PI_TIMING=1 pi -p "reply ok" --model nr-deepseek/deepseek-v4-flash --thinking off)

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
