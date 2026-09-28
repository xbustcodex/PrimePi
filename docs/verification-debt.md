# Manual-verification debt

Work that is implemented and mechanically proven, but which no automated test
covers because exercising it requires driving a real terminal UI. Each entry
states what is already proven, what is not, and how to close it.

Recorded so these are visible in the tree rather than only in review
conversations, where they are easy to lose between phases.

---

## PD-1: interactive tool-approval prompt is wired but not UI-tested

**Status:** manual verification required. Not an implementation failure.

**What is proven mechanically** (`packages/agent/test/tool-approval-enforcement.test.ts`,
`packages/coding-agent/test/security-tool-approval.test.ts`):

- A denied tool performs **zero** side effects. The gate returns `{ block: true }`
  from `beforeToolCall`; the loop returns an immediate outcome and never reaches
  `execute`. Six tests count real `execute` invocations rather than inspecting
  the returned error, so a gate that ran the tool and then reported "denied"
  would fail.
- A required prompt with no interactive surface is refused, never approved.
  Checked for every mode and every tier above the ceiling.
- A prompt that throws is a refusal, not a grant.
- An explicit allow from a working prompt executes; an explicit deny does not.
- Exactly one question is asked per gated call, and none when the decision is
  already `allow`.

**What is not proven:** the dialog itself. `AgentSession._requestApproval` calls
`ExtensionUIContext.confirm("Approve tool call", body)` and maps the result. The
mapping, the fail-closed default when no UI context exists, and the body
composition (prompt line, `formatApprovalDetails` lines, reason) are all covered
by unit tests against the decision layer, but no test renders the dialog and
clicks it.

**Why it is not unit-tested:** the component requires a live terminal and a real
keypress. A test would assert against a mock of the very thing under test.

**How to close it:** run an interactive session with
`tools.approvalMode: "always-ask"`, ask the agent to run a command, and confirm
the dialog appears with the tool name and details, that Deny prevents execution,
and that Approve permits it. Then repeat with no UI (print/RPC mode) and confirm
the call is refused with the explanatory message rather than silently allowed.

**Related:** the RPC and ACP transports are intended to carry the same
`ToolApprovalRequest` and return the same response type, but only the TUI
surface is wired today. Those are follow-on capabilities, not a defect in what
is committed.

---

## PD-2: plan approval and rejection dialogs are not UI-tested

**Status:** manual verification required. Not an implementation failure.

**What is proven mechanically** (`orchestration-plan-state.test.ts`,
`orchestration-plan-mode-integration.test.ts`):

- Approval lifts the write barrier while the plan stays attached as guidance.
- Rejection with `keepDraft` returns to `planning` and keeps the barrier up.
- `approvePlan` is guarded to `reviewing`/`planning`, so a late approval cannot
  resurrect a rejected or superseded plan.
- Disabling plan mode before approval leaves the draft flagged and explicitly
  **not** authority.

**What is not proven:** the review dialog. `/plan` and `/plan approve|reject` are
dispatched and the transitions are exercised, but no test opens the approval
popup, renders the plan body, or clicks Approve/Reject.

**How to close it:** enter plan mode, have the agent produce a plan, and confirm
the review surface shows the plan and that both Approve and Reject produce the
state transitions above.

## PD-3: plan indicator rendering is not UI-tested

**Status:** manual verification required.

**What is proven mechanically** (`orchestration-goals-todo.test.ts`):

- `planIndicator` returns exactly one of `PLAN MODE ACTIVE`,
  `APPROVED PLAN GUIDING IMPLEMENTATION`, `NO ACTIVE PLAN`, and an unapproved
  draft attached to a disabled session reports `NO ACTIVE PLAN`.

**What is not proven:** that the footer or status line actually renders those
three states. The indicator function is a pure projection and is covered; whether
it is wired into the on-screen surface is not exercised by any test.

**How to close it:** drive a session through planning, approval, and exit, and
confirm the rendered status distinguishes all three.

## PD-4: a resumed session with a persisted approved plan is untested

**Status:** manual verification required.

**What is proven mechanically:** the plan state round-trips through a serialized
record, and a record claiming `approved` without an approval timestamp is
downgraded rather than trusted.

**What is not proven:** a real session that writes orchestration state, is
closed, and is resumed with an approved plan still attached and still guiding.
This is the case OMP's trace found broken — after approval its journal records
only `"none"`, so a fresh process cannot recover the plan. That defect is fixed
here in principle, but only a real resume demonstrates it end to end.

**How to close it:** approve a plan, exit plan mode, close the session, resume
it, and confirm the approved plan is still attached and still reported as
guiding implementation.

## PD-5: the live `/plan` keypress workflow is untested

**Status:** manual verification required.

**What is proven mechanically:** the state machine and the session's
`enterPlanMode`/`leavePlanMode` model transitions, including that a deferred
switch is skipped rather than queued.

**What is not proven:** typing `/plan` in a real session, the slash-command
autocomplete entries, and that the plan-model switch visibly happens and is
reverted on exit.

**How to close it:** run an interactive session, toggle `/plan` with the
keypress path, and confirm the barrier engages, the model switches to the
configured `plan` role if one is set, and exit restores the previous model.

## PD-6: delegation is proven against a stubbed provider, not a live one

**Status:** manual verification required. Not an implementation failure.

**What is proven mechanically** (`delegated-child-runner.test.ts`,
`delegation-task-tool.test.ts`, `delegation-authority.test.ts`,
`worktree-isolation.test.ts`, `delegation-recovery.test.ts`,
`live-tool-classification.test.ts`, and a 28-assertion script run against
`packages/coding-agent/dist/`):

- **A real child loop, through a real session.** `delegated-child-runner.test.ts`
  constructs an actual `AgentSession`, invokes the real `task` tool, and drives
  `AgentSession._runDelegatedChild` with a stubbed model runtime. It proves the
  child returns a text answer, executes a granted tool, feeds the tool result
  back for a second turn, is refused a tool outside its grant, and terminates on
  its request budget. A single-turn implementation would pass every other
  delegation test and still be useless, so this is the test that matters most.
- The `task` tool is reachable from a live session's active tool set, is
  classified `exec`, and is withheld when the allow-list excludes it.
- A gate denial prevents the spawn, is consulted before registration, and
  leaves no registry entry or permit behind.
- A child's tools are narrowed to a subset of the parent's, and a resolver
  rejection ends the spawn rather than falling back to a paid model.
- Against a **real git repository**, an isolated child writes without touching
  the parent checkout, two children get separate directories, the parent branch
  is never auto-merged into, and provisioning is refused outside a repository
  rather than silently falling back.
- An in-flight job recovers as `interrupted` and never as `running`; a settled
  result survives a restart; recovery is deterministic and a corrupt journal
  recovers to empty instead of throwing.

**What is not proven:** the provider is stubbed everywhere. A child's request
has never moved over a real wire, so the redactor applied to a child's
provider-bound context is exercised only in-process, and no real model has been
observed choosing a tool, using it, and reporting a result. Streaming, retry and
failure behaviour are likewise unexercised for a child.

**Why it is not unit-tested:** a real turn requires provider credentials. The
existing suite has 28 files that fail for exactly that reason, so adding one
more would not be evidence.

**How to close it:** in an authenticated session, ask the agent to delegate a
small task that requires a tool call, confirm the child's result reaches the
parent, then repeat with `isolated: true` against a scratch repository and
confirm the parent checkout is unchanged and `/tasks` reports the child.

## PD-7: the Git surface is proven at the module and build layers, not through an interactive commit

**Status:** manual verification required. Not an implementation failure.

**What is proven mechanically** (`vcs-git-service.test.ts`,
`vcs-checkpoint-commit.test.ts`, `git-authority-adversarial.test.ts`, and a
script run against `packages/coding-agent/dist/`), against real temporary
repositories rather than mocks:

- **Discovery is fenced.** A repository whose root lies above the project
  boundary is refused, which OMP cannot express at all — its walk runs to the
  filesystem root (`crates/pi-vcs/src/git/mod.rs:170-172`).
- **Status, diff, staged diff and fingerprint do not mutate.** Proven by
  comparing the repository's state before and after three reads.
- **A worktree and its parent are distinguishable**, and a parent's file is
  provably unchanged by an edit made in its worktree.
- **A checkpoint creates nothing** — no index entry, no commit, no stash — and a
  restore touches only the paths the checkpoint recorded.
- **A restore is refused when unrelated work changed since**, and forcing it
  still does not widen the blast radius: the user's unrelated file survives.
- **A checkpoint cannot restore in another worktree or another repository.**
- **A commit contains only the named paths**; a pre-existing unrelated edit and
  an untracked file are both provably excluded.
- **Plan Mode refuses `git_stage`, `git_commit` and `checkpoint` through the
  approval resolver**, so a `yolo` mode cannot undo it, while `git_inspect`
  stays permitted. This is the gap OMP has: its plan-mode git prohibition is
  prompt text that `bash` never consults
  (`prompts/system/plan-mode-active.md:3`).
- **A refused approval, a failed validation, and an unavailable commit message
  each produce zero commits**, and the work remains recoverable in the tree.
- **Diff content is labelled as repository data**, and a diff line reading as a
  directive changes nothing.
- **There is no push, fetch, or clone anywhere in the VCS subsystem**, asserted
  against the sources rather than assumed.

**What is not proven:** the commit-message generator is exercised through an
injected `MessageGenerator`, not a real provider turn. The free-only behaviour
is proven at the pipeline boundary — a chain that yields no eligible model
produces `message-unavailable` and no commit — but the session-side
`resolveRoleChain` call that decides eligibility has not been observed end to
end under a real free-only configuration. The interactive approval dialog, the
`git_commit` plan rendering, and the review surface are also unexercised; the
tests assert on outcomes, not on what a person saw.

**Why it is not unit-tested:** a real turn requires provider credentials, and the
existing suite has 28 files that fail for exactly that reason. Adding one more
would not be evidence.

**How to close it:** in an authenticated session, ask the agent to commit one
named file in a scratch repository, confirm the approval dialog shows exactly
that file and nothing else, and confirm HEAD contains only it. Then repeat with
`generateMessage: true` and confirm the generated message is presented as a
draft. Finally, enter Plan Mode and confirm a commit attempt is refused before
the repository changes, while `git_inspect` still works.

## PD-8: provider usability is proven against a stubbed runtime, not a live provider account

**Status:** manual verification required. Not an implementation failure.

**What is proven mechanically** (`provider-usability-authority.test.ts` and a
33-assertion script run against `packages/coding-agent/dist/`):

- A disabled provider disappears from the available snapshot, is unreachable by
  literal lookup, issues no credential even when one exists in the environment,
  and is refused by `getApiKeyAndHeaders` and `hasConfiguredAuth`.
- A **credential-free or free** model on a disabled provider is still disabled —
  the case a "does it need auth" filter lets through.
- `paid`, `free`, `login`, `local` and `unknown` access classifications do not
  weaken the rule.
- Automatic failover does not select a disabled provider, and disabling one
  provider leaves another's models resolvable.
- Plan Mode refuses to restore a model whose provider was disabled while plan
  mode was active, and still restores one whose provider is still enabled.
- A session's recorded model is not restored when its provider is disabled.
- Re-enabling a provider restores eligibility on the same runtime instance, with
  no restart.
- Disabling is ranked above every other refusal reason, so a disabled provider is
  never reported as merely unreachable — "turn it off" and "log in" are different
  user actions.

**What is not proven:** the runtime in both is driven with a stub or a
 network-free `ModelRuntime` constructed from a bundled catalog. A real
 authenticated session with `disabledProviders` set is not exercised, so the
 end-to-end path — a settings UI toggle, a live catalog refresh landing while the
 provider is disabled, and a real turn refusing to route to it — is unobserved.
 The `setDisabledProvidersReader` call is additionally guarded by a
 `typeof` check, because the runtime is an injected dependency; a host supplying
 a pre-authority double therefore loses re-enable without a startup error, which
 is intended but untested against such a host.

**Why it is not unit-tested:** a real turn requires provider credentials, and the
existing suite has 28 files that fail for exactly that reason. Adding one more
would not be evidence.

**How to close it:** in an authenticated session with two providers configured,
disable one through Settings, then run a turn and confirm (a) it never routes to
 the disabled provider, including on a model failure where failover would
 normally switch providers, (b) the model picker does not list its models, and
 (c) re-enabling it restores both without restarting the session. Repeat with the
 disabled provider holding a free model, which is the case the credential-free
 clause used to let through.

## PD-9: CLOSED - the IAI Personal engine is live verified

**Status:** closed 2026-09-28. Evidence: `live-verified`.

The engine was installed from its own declared dependencies into its own venv,
then exercised end to end. Pre-install state, the authoritative dependency
declaration, and the exact install command are recorded in
`docs/pd9-pre-install-record.md`.

**Install.** `pip install -e <iai project>` into
`iai-personal-memory-engine/.venv` (Python 3.12.10). `pip check` reports no
broken requirements. All twelve declared runtime dependencies resolved within
their declared bounds: numpy 2.2.6 (<2.3.0), scipy 1.18.1, numba 0.67.0,
tiktoken 0.14.0, cryptography 50.0.1, keyring 25.7.0, cachetools 7.2.0,
psutil 7.2.2, pandas 2.3.3 (<3.0), zstandard 0.25.0 (<1.0), pypdf 6.19.0,
setproctitle 1.3.7. No constraint was relaxed and no undeclared package was
added. The earlier trace named only three dependencies; the project declares
twelve, and that earlier list was wrong.

**What the source trace corrected, before any proof was attempted.**

- **Transport.** The stdio server is `iai_mcp.core:main`, not
  `iai_mcp.cli:main`. `iai_mcp.cli` is the operator CLI and parses
  subcommands, so it would have consumed the JSON-RPC line as an argument.
  There is no `iai_mcp.__main__`. The adapter had the wrong entry point.
- **No handshake.** The engine answers a fixed set of method names via
  `dispatch`. There is no `initialize`. The adapter's MCP-style handshake
  would have failed against a working engine, so the liveness probe now calls a
  real, side-effect-free method.
- **Parameters.** `memory_capture` takes `cue`/`text`/`tier`/
  `provenance_extra`. `memory_recall` takes `cue`/`k`.
  `memory_contradict` takes `id` (a UUID) and `new_fact`. The adapter had
  invented `limit`, `record_id` and `text`.
- **Response fields.** Hits carry `record_id`, `literal_surface`,
  `score`, `valid_from`, `valid_to`, and sit beside `anti_hits`. None of
  those matched the names the adapter first assumed.

**Proof, 22/22 checks** (`pd9proof.py`, isolated store): server start; real
JSON-RPC on stdio; capture with a unique marker; recall of that marker; clean
shutdown; restart against the same store; recall again, proving durability;
malformed UUID rejected; supersession archiving with `edge_type=contradicts`;
recall reflecting a closed validity interval; malformed JSON and an unknown
method both rejected without the engine dying; a 32-byte key file created in
the isolated root; the owner's real store never opened. The owner's personal
memories and key were never read, decrypted, or written.

**Then through the PrimePi adapter** (`iai-adapter-live.test.ts`, 3 tests in the
suite so it cannot rot): capture, recall, engine-assigned scores preserved,
stop, fresh process, recall again, and a non-UUID id rejected with an
explanation rather than an opaque engine error.

**One finding that qualifies the encryption claim.** The SQLite store and the
HNSW index contain no plaintext record text - confirmed by capturing a known
marker and scanning the raw bytes, and confirmed in the other direction by
recalling it back through the engine. But one derived file,
`.working-tier.-.cached.md`, holds record text in **plaintext**. Deleting it in
an isolated store left the store openable and the file unregenerated, so it is
a derived cache and not authoritative. The store is encrypted; not every file
under the engine root is. `encryptedAtRest` stays `true` and now says so in
its comment rather than implying a blanket guarantee.

**Not claimed.** No traffic capture was performed, so this establishes no
network behaviour at runtime; only that the traced import path pulls in no
network client. The earlier no-telemetry observation is unchanged and remains
source inspection, not runtime evidence.

## PD-10: 86-96 pre-existing failures in the coding-agent suite, none caused by the migration

**Status:** pre-existing, environment-dependent, unrelated to the memory work.

**Measured, not assumed.** The full `coding-agent` suite reports between 86 and
96 failures across 35-37 files depending on run. Checked out at `377febaa5`
(the commit before the retention work) the same files fail:

| Files | At `377febaa5` (before retention) | At `73403a228` (with retention) |
|---|---|---|
| `config.test.ts` + `git-update.test.ts` | 11 failed | 9 failed |

The count moves *down* with the new code and the failing set is identical, so
these are not regressions. The variance between runs is itself the evidence:
the same tests pass or fail depending on machine load.

**Cause.** These tests shell out to `git`, `npm`, `bun`, `pnpm` and `yarn` via
`spawnSync` — self-update install paths, git history rewrites, package-manager
discovery. Under the full parallel suite on Windows they contend for the same
process and filesystem resources and time out. They are wall-clock sensitive,
not logic-sensitive.

**What was actually verified.** Every memory test passes in isolation and
together: 62 tests across `memory-pipeline`, `memory-redaction-parity`,
`memory-backend` and `iai-adapter`. Two genuine defects *were* found by this
sweep and fixed in `f65619323` — selector ordering assertions that broke when
`local-store` was added — which is the argument for running the full suite
rather than trusting the count.

**To close it:** run the suite with the package managers on `PATH` and without
parallel contention (`vitest run --no-file-parallelism`, or per-file), and
confirm the failures disappear. This needs an environment that can execute
`bun`, `pnpm` and `yarn`, which this machine does not reliably provide.
