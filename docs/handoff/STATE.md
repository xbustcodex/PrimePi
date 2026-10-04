# PrimePi handoff

**Written by Space Bunny at retirement.** Everything the next model needs to resume without
re-deriving it. Current HEAD and exact state are in §1.

---

## 1. Current state

    HEAD                    3295335bf  docs(handoff): the remaining worker-adoption gap,
                                        traced to an endpoint asymmetry
    working tree            clean
    stash                   stash@{0} untouched (WIP on main: 7e40f7dac) — do not apply,
                            pop, drop or modify
    untracked               none

| package | result |
|---|---|
| `packages/coding-agent` | **17 failed / 4040 passed / 65 skipped** (4122) |
| `packages/client` | 0 failed / 32 passed / 11 skipped (43) |
| `packages/server` | 0 failed / 44 passed / 7 skipped (51) |
| `npm run check` | exit 0, 0 errors, 0 warnings |
| `npm run build` | exit 0, 0 errors |
| `tsgo --noEmit` | 0 errors |
| evidence ladder | 0 violations; independent cross-check agrees at 69 |

A recurring artifact `packages/coding-agent/Microsoft/` appears when a PowerShell module
scan runs. It is not work — delete it.

---

## 2. The 17 remaining failures

    10  test/experimental-remote-runtime.test.ts   worker adoption — see §3
     3  test/trust-selector.test.ts                 module-load bound, see §4
     2  test/interactive-mode-status.test.ts         module-load bound, see §4
     1  test/extensions-discovery.test.ts            jiti, upstream — see §5
     1  test/suite/regressions/extension-factory-cache.test.ts   same jiti cause
     1  test/startup-session-name.test.ts           passes alone; load-sensitive

**None of these is external.** The only genuinely external blocker is provider funding
(§6).

---

## 3. The one real remaining gap: worker adoption

`docs/handoff/worker-adoption-open.md` has the full trace. The short version:

A replacement server does not adopt the Session worker the previous generation left
running, so `workerPids.get(sessionId)` is `undefined`.

    server.ts:695   ensureCoordinator(socketPath, controlPath)
    server.ts:696   new CoordinatorConnection({ controlPath, endpoint: serverPath })
    coordinator.ts  binds publicPath (= socketPath); proxies to currentServer.endpoint

A POSIX socket file can be `link`ed, so one listener answers to two names. **A named pipe
cannot be aliased**, so on Windows the coordinator's pipe and the server's pipe are two
unrelated kernel objects. The surviving worker holds the previous generation's endpoint, and
after replacement the coordinator's routing and the worker's recorded endpoint disagree.

**The next action, in order:**

1. One probe: log the coordinator's `broadcast({ type: "discover_workers" })` fan-out
   (`coordinator.ts:437`) and the worker's `announce()` (`session-worker.ts:676`) on the
   replacement path.
2. Broadcast **reaches** the worker but `#recordReadyWorker` drops it → local fix, in its
   validation of `sessionKey`/`sessionId`/absolute paths.
3. Broadcast does **not** reach the worker → architectural. Three options are set out in
   that document; option 3 (re-register workers on `server_connected`) is smallest.

Do not guess. `discover()` has a 5s timeout that resolves either way, so a missed adoption
is **silent** — that is why this was not patched speculatively.

---

## 4. Module-load bound suites (5 failures)

Not defects. Measured:

    whole file, 33 tests     wall 35527ms   test-time 324ms
    one test, 32 skipped     wall 35094ms   test-time  23ms

Adding 32 tests costs 1ms of test time. The wall time is vitest transforming modules, paid
once per worker; `interactive-mode-status.test.ts` imports `InteractiveMode`, which pulls in
the whole interactive surface.

**No timeout was raised**, because that would also hide the two genuine jiti timeouts
(§5). Both are 30s of *real work*, not loader overhead — keeping them distinguished is the
point. Detail in `docs/verification-debt.md` PD-14.

---

## 5. jiti `tsconfigPaths` (2 failures) — upstream, byte-identical

`tsconfigPaths: true` costs **~1.8s per extension import** against this repo's 38-entry
path map containing a `"*": ["./*"]` wildcard. Content size is irrelevant; reusing one jiti
instance does not help; an explicit tsconfig path does not help.

Verified **byte-identical to the upstream clone point `5fd446ca`** — an upstream pi defect
the fork inherited. `moduleCache: false` cannot fix it (jiti consults it *after* resolution)
and must not be changed (three regression tests pin `/reload` picking up edited extension
code).

Fixing it upstream means either not re-parsing the tsconfig per jiti instance — jiti
exposes no such option — or narrowing the map jiti sees, which changes what a user's
relative imports resolve to.

---

## 6. External live-provider blocker

**Do not purchase credits. Do not alter credentials.**

    GET  https://openrouter.ai/api/v1/models   -> key works, 466 models   (free endpoint)
    POST a real completion                     -> 402 billing_error
                                                "This account never purchased credits"
    POST https://api.openai.com with OPENAI_API_KEY
                                             -> 401; that variable holds an sk-or-v1-
                                                token, i.e. the same OpenRouter key

Model **discovery** is proven; **completion** is blocked by an empty credit balance. Steps
1–5 and 9–11 of the paid-evidence loop cannot run. `docs/verification-debt.md` PD-6 and
PD-8 remain open for the same reason.

---

## 7. Windows transport and discovery — what was built

### Transport (`packages/server/src/transports/windows-named-pipe/`, `packages/client/src/windows-named-pipe.ts`)

`node:net` bound to `\\.\pipe\`. This is **OMP's own posture**, adopted rather than
invented: `collab/registry.ts:1-25` states "Unix domain socket on POSIX, named pipe on
Windows … per-request bearer authentication", and `:207-211` uses `timingSafeEqual`.

Security properties, in the order they were established:

| property | mechanism |
|---|---|
| only the intended peer connects | credential in `hello`, constant-time compared |
| endpoint cannot be impersonated | `EADDRINUSE` on bind is atomic and exclusive |
| stale endpoint cannot attract a client | no filesystem residue; a pipe dies with its owner |
| identity is not the pathname | credential proved in-band after connecting |
| cleanup touches only its own endpoint | named by the exact name bound |
| reconnect cannot cross identity | every reconnect re-runs the `hello` gate |
| not network-accessible | no host, no port; any non-`\\.\pipe\` path is rejected |
| failure closed, explicit, diagnosable | every refusal throws a named error |

**Not claimed:** there is no owner-only ACL. `node:net` cannot set a pipe security
descriptor, so "only the intended peer" comes from the credential. Closing that properly
needs a native pipe DACL — the one architectural follow-up worth considering.

### Discovery (`packages/coding-agent/src/experimental/endpoint-registry.ts`)

One JSON file per server under `<serverDirectory>/endpoints/<serverId>.json`, where
`<serverDirectory>` is the **existing** authority `resolveServerDirectory()`
(`PI_SERVER_DIR` or `~/.pi/server`) — no new configuration root.

**The architectural rule, which is the whole point:**

    registry -> candidate endpoint -> connect -> transport authentication -> usable server

An entry is a filename plus a PID. Neither proves anything. `probeRegisteredEndpoint` opens
a **real `Client`** and requires the `hello` handshake to complete, so the credential check
decides. `pidAlive` is used only to *prune*, never to select, so PID reuse cannot prove
identity. **No credential is written to disk.**

Publish and discover are both `win32`-gated; **Unix behaviour is unchanged** — a POSIX
socket is a directory entry and `discoverUnixServers` finds it by scanning.

37 adversarial cases in `packages/coding-agent/test/endpoint-registry.test.ts`, covering
every scenario in the brief. Two real defects were found by them and fixed:

- `publishEndpoint` accepted an unvalidated `serverId`, which becomes a **filename** —
  `../../escape` was a path-traversal vector. `assertPublishable` now rejects before any
  filesystem write.
- an unparseable `createdAt` made an entry simultaneously *selectable* (parse accepted it)
  and *prunable* (`Infinity` age), depending on which code path looked. Now it fails
  validation: never selected, still prunable on positive evidence.

---

## 8. Architecture authorities and invariants

Do not weaken these; they are load-bearing.

| authority | where | rule |
|---|---|---|
| `ModelAccess` / `isCredentialFree` | `packages/ai/src/types.ts`, `utils/free-model.ts` | classify; never infer paid/free from provider identity |
| `policyAllowsPaid` | `packages/ai/src/utils/failover.ts` | the sole paid-spending gate |
| `selectFailoverCandidate` | same | final eligibility gate for **every** model hop |
| failure scopes / cooldowns | `utils/availability.ts`, `utils/availability-cooldowns.ts` | `FailureScope` = model/route/funding-pool/provider |
| provenance-preserving context edits | `core/session-manager.ts` | branch, never delete |
| project trust | `core/settings-manager.ts` | project layer unread/unwritable when untrusted |
| **self-update barrier** | `utils/self-update-barrier.ts`, consulted at `package-manager-cli.ts:1025` | env opt-in only, **before** any install-detection |
| typed settings registry | `core/settings-registry.ts` | settings declare through it, not ad hoc |
| memory authorities | `packages/agent` | see PD-6/PD-8 — unproven against a live provider |

**The single architectural rule:** ported subsystems *propose* models; they never *select*
them. Anything resolving a model ends in `selectFailoverCandidate`.

### Compaction precedence (`81fc798c0`)

`AgentSession.compact()` resolves summarisation auth **before** the size guard
(`:4314` then `:4318`), so a missing credential surfaces as itself rather than as
"Nothing to compact". The predicate is now **behavioural**:

    if (!apiKey && !headers && this._modelRuntime.hasConfiguredAuth(model.provider)) {
        return this._getRequiredRequestAuth(model, signal);   // throws, as the request path does
    }

It was `agent.streamFunction === streamSimple`, which is false for every SDK session
because `sdk.ts:427` always installs a wrapper — so the requirement never fired. Reading
`hasConfiguredAuth` off the injected runtime keeps the SDK abstraction unconstrained.

### Cross-package build invariant (PD-13)

**A green `npm run check` is necessary but never sufficient for an exported-contract
change.** `check` typechecks against each workspace's **source**; `build` typechecks against
each dependency's generated **dist**.

Order: `check` → **rebuild producer A** → **build consumer B against A's artifacts** →
inspect the **shipped declarations**. Apply transitively.

It fails both ways, and each is dangerous: a false green hides the break until install or
publish; a false red invites weakening correct consumer code to match a stale artifact.
This bit twice in one session — a stale `pi-server/dist` produced a run of phantom
`ERR_UNSUPPORTED_ESM_URL_SCHEME`-style failures and an 81-error corruption that was one
mangled line.

### Browser-bundle safety

`packages/client/src/unix.ts` is deliberately **not** re-exported from the index: the smoke
bundle builds with `platform: "browser"`, where no Node builtin resolves. Platform transports
belong behind a subpath. `npm run check:browser-smoke` enforces it.

---

## 9. Deliberate PrimePi divergences from OMP

1. **Stronger bearer comparison.** OMP's daemon broker uses `!==`
   (`launch/broker.ts:546`); its collab registry uses `timingSafeEqual`
   (`collab/registry.ts:211`). PrimePi uses the stronger of OMP's two own patterns.
2. **Credential only where the transport needs it.** OMP always sends a token. PrimePi sends
   one only for a named pipe, so POSIX keeps relying on `0700`/`0600` and nothing about the
   existing contract changes.
3. **Windows discovery exists at all.** OMP has no equivalent — `grep -rln
   "parity-ledger\|settings-parity"` and any named-pipe *enumeration* both return nothing.
   OMP's collab registry is told its endpoint by metadata; PrimePi's client enumerates.
4. **Endpoints are not aliased.** PrimePi gives the coordinator and the server two names.
   POSIX tolerates this via `link()`; Windows cannot, which is exactly §3.

Byte-level parity verified in `docs/handoff/omp-parity-check.md`. The reference repo
`oh-my-pi` is **unmodified** (one pre-existing untracked `tree.txt`).

---

## 10. Commands to resume

```bash
cd C:/Users/xkali/new_ai/pi

# The 10 worker-adoption failures — start here
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/experimental-remote-runtime.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/endpoint-registry.test.ts   # 37, green

cd ../..
npm run check          # biome + 6 integrity gates + tsgo + browser smoke
npm run build

# Per-PD-13, after touching an exported contract:
npm run build --workspace=@earendil-works/pi-protocol
npm run build --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-client
npm run build --workspace=@earendil-works/pi-coding-agent

npx tsx scripts/reconcile-evidence.mts      # must report 0 violations
```

Full-suite runs take ~8 minutes for coding-agent. Do not raise a global `testTimeout` —
see §4.

---

## 11. Standing rules for the next model

- **No `git stash`.** `stash@{0}` is pre-existing and must be left exactly as it is. Never
  `add -A`, `amend`, `rebase`, `reset`, `push`, or `clean`.
- Stage **explicit paths**.
- A `git stash`-based "does this predate my change?" comparison is a violation. Use
  committed-revision inspection (`git show HEAD:path`), a temporary `E:` copy, or
  `git archive`.
- E: scratch lives in `E:/PrimePi-Temp/`. Findings only in `E:/PrimePi-Temp/tools` must be
  promoted into `docs/` if the next model will need them. Do not commit probe noise.
- Proven by measurement, not resemblance. Several defects in this campaign *looked* like one
  thing and were three: four wrong pipe-name regexes each failed silently; a `TypeError`
  from a missing `test/suite` path segment was read as a product defect until the byte-level
  comparison contradicted it.

---

## 12. Outstanding verification debt

| item | where | blocked on |
|---|---|---|
| live turn, streaming, retry, failure behaviour | PD-6, PD-8 | provider credits |
| tool download in an isolated HOME | PD-12 | network |
| symlink creation | PD-12 Class B | Windows Developer Mode / `SeCreateSymbolicLinkPrivilege` |
| bash `pwd` reports an MSYS POSIX view | PD-12 Class A | by design; asserted via the shell's own conversion |
| tool-approval and plan dialogs | PD-1, PD-2, PD-3 | a real terminal UI session |
| orchestration resume from persisted state | PD-4, PD-5 | a real session lifecycle |
| native pipe DACL | this doc §7 | a native addon; would strengthen P1 to OS-enforced |
| worker adoption | §3 | the one probe described there |
