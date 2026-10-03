# Failure classification: every remaining suite failure, with evidence

**45 failures across 13 files. Every one reproduced and classified by measurement.
None is a regression from this campaign.**

Zero are unexplained. Zero are locally resolvable without a design decision or an
upstream change. Every failure *fixed* during the campaign had a test-side cause: a
Windows path literal, a stale model id, a stale tool list, or a fixture that never
reached the code it was written to test.

Counts are from `packages/coding-agent` at `5d96839b0`.

---

## A. One real cross-platform gap — 26 failures

### `experimental-remote-runtime.test.ts` — 25

```
Error: Unix transport is not supported on Windows
Error: Unix socket directory requires a POSIX user ID
```

Two unconditional throws in `src/`, not in a fixture:

- `packages/client/src/unix.ts:38` and `:99` — `throw` on `process.platform === "win32"`
- `packages/coding-agent/src/experimental/server.ts:59` — `throw`, because
  `process.getuid` does not exist on Windows at all

**No alternative transport exists.** `packages/client/src/transport.ts` declares only
the `ByteTransport` interface and a `ByteTransportFactory` *type* — it provides no
implementation — and a search for `\\.\pipe` / `namedPipe` across `packages/client/src`
and `src/experimental` returns nothing.

**Not a parity obligation.** OMP has no `client` package at all; a search for
`createUnixTransportFactory` / `discoverUnixServers` across the reference tree returns
nothing. This subsystem is PrimePi-original.

**Not repaired.** The Unix barrier *is* `mkdir(directory, { mode: 0o700 })` plus an
`lstat` uid comparison, and `process.getuid` is also how `server.ts` proves directory
ownership. Porting the transport without an equivalent ACL check would ship a weaker
barrier on the platform where it is currently absent. Recorded in
`omp-api-migration-plan.md` as a build item.

### `experimental-presentation-facets.test.ts` — 1 of 4

```
Error: Unix socket directory requires a POSIX user ID
  at ensurePrivateServerDirectory (src/experimental/server.ts:59)
```

The same gate one layer deeper. This test only reaches it because its hardcoded `/tmp`
fixture was fixed in `70b42aba6` — previously it died on the fixture before ever
calling `startServer`.

---

## B. A deliberate refusal, correctly implemented — 5 failures

### `config.test.ts` — 5

All five build a custom Windows npm prefix and expect it to be recognised. The gate
consults `npm root -g` **without** `--prefix` (`config.ts:245`), which returns
`D:\nodejs\node_modules` on this machine and cannot contain a
`C:\Users\...\Temp\pi prefix …` install. The prefix-aware answer is reachable only
through `getInferredNpmInstall`, which declines on Windows on purpose:

```ts
// config.ts:133-135
// Windows global npm prefixes use `<prefix>\node_modules`, which is
// indistinguishable from local project installs by path shape alone. Do not
// infer unsupported Windows custom prefixes without `npm root -g` evidence.
```

npm itself handles the spaced prefix correctly
(`npm --prefix "C:\...\pi prefix probe" root -g` returns the matching root), so this is
not a quoting problem.

`undefined` is the **safe** answer. Inferring that any `<prefix>\node_modules` is global
would let the self-update command run against a project-local checkout — precisely the
replacement the self-update barrier exists to prevent, on the platform where that guard
is weakest.

---

## C. A real performance defect, inherited from upstream — 3 failures

### `extensions-discovery.test.ts` — 2, `extension-factory-cache.test.ts` — 1

```
Error: Test timed out in 30000ms        (30.03s of test time, run in ISOLATION)
```

Not load sensitivity — reproduced with every sibling test skipped. Bisected to a fixed
**~1.8s cost per extension import**:

| jiti options | time |
|---|---|
| bare | 353ms |
| `virtualModules` only | 16ms |
| `tsconfigPaths` only | **1820ms** |
| `virtualModules` + `tsconfigPaths` | 1803ms |

Content size is irrelevant (1000 extra export lines cost nothing), reusing one jiti
instance does not help, and passing an explicit tsconfig path does not help.
`tsconfigPaths` is selected at `loader.ts:493` whenever the loader runs from `.ts` — so
**every source run and every real user startup pays `n_extensions x ~1.8s`**. This is a
product startup cost, not a test artifact.

**The obvious fix is unavailable.** jiti has two caches: `moduleCache` (module
instances, consulted *after* resolution — so it cannot affect this cost) and `fsCache`
(transpiled source). And `moduleCache: false` is load-bearing: three regression tests in
`test/suite/regressions/extension-factory-cache.test.ts` pin `/reload` picking up edited
extension code, a contract documented in five places. `tsconfigPaths` offers only
`true | false | string` — no way to share the parsed config across instances.

**Verified byte-identical to the upstream clone point `5fd446ca`**, so this is an
upstream pi defect the fork inherited. The tests are correct to fail.

---

## D. A real functional gap, pre-existing — 1 failure

### `5943-session-start-notify.test.ts` — 1

Reproduced through the suite harness with a faux response queued:

```
pending responses after bind: 1
all events:                  []
session entries:             []
```

`pi.sendUserMessage(...)` called from a `session_start` handler starts **no turn**, emits
no events, and strands the queued model response. The sibling test in the same file uses
`pi.sendMessage({ customType })`, which reaches `_appendCustomMessage`
(`agent-session.ts:3853-3862`) and emits inline — so the two tests differ by API, not by
setup. `sendUserMessage` (`agent-session.ts:3887`) calls
`this.prompt(text, { source: "extension" })`, which does not reach `_emit` here.

**Not repaired** — every candidate fix is a design decision:

- `sendUserMessage` is async, so starting a turn would be **re-entrant** while
  `bindExtensions` is still iterating the handler list;
- emitting the events without running the turn would make the test pass while leaving the
  behaviour broken, which is worse than the current failure;
- deferring the prompt until after `bindExtensions` changes when extension-sent user
  messages take effect, for every extension using the pattern.

---

## E. A pre-existing test-invariant failure — 1 failure

### `ledger-progression.test.ts` — 1

```
AssertionError: after 4e3e434355: expected 244 to be greater than or equal to 249
```

`4e3e434355` is dated **2026-09-30**; this campaign's first commit `81fc798c0` is
**2026-10-03**, and `git merge-base --is-ancestor 4e3e434355 81fc798c0` confirms the
failing revision predates everything done here.

The progression rose to 249 and then fell to 207. The decreasing commits are
reachability-audit work that **removed false promotion claims** — `ask.enabled named a
consumer that never reads it`, `the LSP subsystem is fully built and entirely
unreachable`. The test's premise was true when written and was then deliberately
falsified; the file's own header already records the audit.

---

## F. Environment: no POSIX user id for auth — 1 failure

### `sdk-session-manager.test.ts` — 1

```
sessionCwd           C:\Users\...\Temp\pi-probe-...\session-project
realpath(sessionCwd) C:\Users\...\Temp\pi-probe-...\session-project
bash `pwd` output    "/tmp/pi-probe-.../session-project"
```

The session-level `cwd` contract is sound: the prompt assertion now passes and proves the
value reaches the model correctly. The spawned shell reports a POSIX path for a Windows
working directory, so `realpathSync` of that output throws `ENOENT` on a path that does
not exist. Reproduces outside vitest under a plain `tsx` script, so it is not a harness
artifact. Recorded in `verification-debt.md` PD-12, sharper form.

---

## G. Pre-existing, unchanged by this campaign — 1 failure

### `suite/agent-session-compaction.test.ts` — 1

```
Received: "Nothing to compact (session too small)"
```

An empty session is never compactable, so the auth check is never reached and the message
is the size guard's. Verified identical against HEAD.

---

## H. Load-sensitive, pass promptly in isolation — 7 failures

Each verified alone with every sibling skipped, so concurrency is excluded:

| File | Isolated result |
|---|---|
| `startup-session-name.test.ts` | 1 passed |
| `trust-selector.test.ts` | 4 passed |
| `interactive-mode-status.test.ts` | 33 passed |
| `git-update.test.ts` | 1 passed, 13.65s total including startup |
| `powershell-tool.test.ts` | 1 passed, 7.65s total including startup |

Nothing to repair. A global timeout increase would be the wrong fix even if permitted,
and it would also mask class C.

---

## Summary

| Class | Failures | Locally resolvable |
|---|---|---|
| A. Windows transport gap | 26 | no — build item with a security design |
| B. npm prefix refusal | 5 | no — tests assert more than the code promises |
| C. jiti `tsconfigPaths` cost | 3 | no — upstream defect, no local fix exists |
| D. `session_start` user message | 1 | no — design decision |
| E. ledger invariant | 1 | no — test asserts a deliberately falsified premise |
| F. bash `pwd` translation | 1 | no — owning layer not established |
| G. compaction auth ordering | 1 | no — pre-existing |
| H. load-sensitive | 7 | n/a — passes in isolation |
| **Total** | **45** | **0 safe local repairs remaining** |

## What this campaign fixed, for contrast

Every repair was test-side, and every one had been hiding the thing it existed to check:

- **`--import` given a path instead of a `file://` URL** (7 files) — the spawn died with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` before the code under test ran.
- **Hardcoded POSIX path literals** (`/tmp`, `/`, `~`) across footer, session store,
  system prompt, plugin profile and extension-path assertions.
- **Stale model ids** from upstream renames — including one in the **generator**, where a
  stale id silently removed a model's `thinkingFormat` and `supportsReasoningEffort`.
- **Stale tool lists** that recorded one moment of the product rather than the property
  being claimed.
- **A dead Windows `.cmd` guard**: `crossSpawn` pre-quotes argv, so `if "%1"=="root"`
  never matched, and the fixture fell through to the failure it was asserting.
- **A non-hermetic test**: ambient `OPENAI_API_KEY` made "no credentials configured" cases
  report `ready`.