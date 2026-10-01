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
- models.dev's `deprecated` flag for OpenCode Zen/Go models is stale (it wrongly marked live free models dead); the generator probes the live OpenCode catalog endpoint as source of truth. Don't reintroduce models.dev-only filtering, and don't re-add OpenRouter `*:free` models that lack tool support (e.g. `z-ai/glm-5.2:free`, Lyria music) — their exclusion is intentional.

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
- Model catalog: `cd packages/ai && npm run hydrate-model-data` (= `generate-models.ts --strict --data-only`) refreshes `packages/ai/src/providers/data/`, which is gitignored — regenerating it yields no git diff, so catalog coverage fixes commit as script/test/changelog changes only.
- The full `packages/ai` vitest suite exceeds 600s (network tests); run targeted tests (e.g. `test/*model*.test.ts`) instead.
- Never commit unless the user asks.

## Local Build and `pi` Command (this Windows machine)

This machine has no published/stock pi installed. The global `pi` command is an `npm link` junction to this working tree, so `pi` always runs the locally built coding-agent and picks up rebuilds with no relinking:

```
D:\nodejs\pi.cmd
  -> D:\nodejs\node_modules\@earendil-works\pi-coding-agent   (Junction)
     -> C:\Users\xkali\new_ai\pi\packages\coding-agent
        -> dist\bundle\cli.js
```

To make changes or pull changes, then verify:

```
cd C:\Users\xkali\new_ai\pi

# make changes / pull changes

npm run build

pi --version
```

- Node is at `D:\nodejs` (v24.21.0, npm 11.19.0), installed from the official zip. `D:\nodejs` is on the *user* PATH, so `node`, `npm`, and `npx` resolve normally in a fresh shell. Use bare commands; only fall back to `D:\nodejs\node.exe` or `D:\nodejs\npm.cmd` if PATH looks stale.
- The user PATH was deduplicated because it had exceeded `setx`'s 1024-char truncation limit. Keep new PATH additions short, and never write a PATH that exceeds 1024 chars with `setx`.
- Never run `pi update self`, `pi update pi`, or install pi from npm. That replaces the junction with a published package, which defeats the local-build setup. To change the local build, re-run `npm run build`.
- `pi` resolves to `D:\nodejs\pi.cmd` in cmd.exe and `D:\nodejs\pi.ps1` in PowerShell. `where.exe pi` shows both.
- User config, credentials, sessions, and extensions live in `C:\Users\xkali\.pi` and are independent of the link. Do not delete or relocate them. Prefer `pi auth check --provider <p> --no-refresh` over `pi auth print-api-key` when confirming credentials, so nothing is printed or rewritten.
- To uninstall the link (leaves the repo and `C:\Users\xkali\.pi` untouched): `npm unlink -g @earendil-works/pi-coding-agent`.

## Windows Machine Environment

Python:

- The canonical interpreter is `C:\Users\xkali\AppData\Local\Programs\Python\Python312\python.exe` (3.12.10, 328 packages). `python`, `py`, `pip`, `ruff`, `mypy`, `uvicorn`, and `fastapi` all resolve into that one tree, so `python` and `pip` share a single site-packages.
- A second, unrelated Python 3.12 exists under `%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.12_...` (295 packages). It has no `python.exe` — only console scripts. Its `Scripts` entry was removed from the machine PATH, but the directory is still on disk because a Store-installed app may depend on it. Do not delete it, and do not let anything re-add its `Scripts` folder to PATH: the two trees have separate site-packages, so `pip install X` would write to the Store tree while `python` reads the Programs tree, and the import would fail.
- If a Python tool appears missing, check which tree owns it before reinstalling. `pip --version` prints the owning site-packages.

PowerShell:

- ExecutionPolicy `CurrentUser` is `RemoteSigned`, which is what lets `npm`, `npx`, and `pi` resolve to their `.ps1` shims and run. If that is ever reverted to `Undefined`/`Restricted`, PowerShell throws `PSSecurityException` on those shims; either restore `RemoteSigned` (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force`) or use the `.cmd` variants (`npm.cmd`, `pi.cmd`) in PowerShell.

Recovery, if `node`, `npm`, or `pi` goes missing:

- Node was installed from the official zip, not an MSI: `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip`, extracted flat into `D:\nodejs`. No registry entry, no uninstaller, no admin rights needed. Re-download, extract, and add `D:\nodejs` to the user PATH.
- PATH backups from the 2026-09-26 cleanup are in `C:\Users\xkali\AppData\Local\Temp\opencode`: `machine-path-backup.txt` (488 chars, pre-Python-consolidation), `user-path-backup.txt` (1069 chars, original), `user-path-backup-2.txt` (114 chars, after the node dedupe). That temp directory is shared with unrelated scratch scripts; do not bulk-delete it.
- `remove-store-python-scripts.ps1` in that same directory is the idempotent, self-backing script that strips the Store `Scripts` entry from the machine PATH. It requires an elevated shell and throws if not elevated.
- Never restore the link by installing pi from npm. Use `npm link` from `packages\coding-agent` (see above), which is offline and needs no registry access.

## Temporary Build and Test Storage

**Before any long autonomous run, read `docs/temp-storage-policy.md`.**

- C: is the smallest and busiest volume on this machine and is reserved for the OS,
  applications, and authoritative development state. Disposable high-volume build/test
  scratch goes to `E:\PrimePi-Temp\`, which has ~97 GB free (D: has ~72 GB as a
  fallback). Re-measure rather than trusting those numbers.
- Each run gets its own id: `E:\PrimePi-Temp\{runs,tests,build}\<run-id>\`.
- **On Windows, `os.tmpdir()` reads `TEMP` and `TMP` and ignores `TMPDIR`.** Setting
  `TMPDIR` alone silently keeps writing to C:. Verified: `TMPDIR` left `os.tmpdir()`
  pointing at `C:\Users\xkali\AppData\Local\Temp`; `TEMP`/`TMP` redirected it correctly.
- Create the run directory first — Node resolves the path but does not create it.
- Verify the redirect took effect by checking the run directory is non-empty after the
  run. Do not assume it worked.
- A single long run was observed leaving 3,214 `pi-*` directories in C:'s Temp. That is
  what this policy exists to prevent.
- Delete a completed run's disposable data after verifying nothing needs it. After an
  interrupted run, inspect the directory before deleting — it may hold recovery state.
- Do not relocate a git worktree on the assumption it gives an independent environment.
  Absolute-path symlinks back into the original checkout defeat that.


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
