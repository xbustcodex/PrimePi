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

## PD-9: the IAI Personal engine is exercised only as far as its dependencies allow

**Status:** partial verification. Adapter and interface are proven; the
engine's own runtime is not.

**What was verified against the built engine** (`iai_mcp` imported from its
`build/lib.win-amd64-cpython-312` under the engine's own venv):

- The native extension imports and exports `MemoryRecord`, `MemoryHit` and
  `RecallResponse`.
- The Python layer imports no network client (`requests`, `httpx`,
  `urllib.request`, `aiohttp`) and no telemetry SDK (`opentelemetry`,
  `sentry_sdk`). That is the mechanical evidence available for the "local only,
  no telemetry" claim; it is not a traffic capture.
- The engine ships `memory_capture`, `memory_recall`, `memory_contradict` and
  `memory_consolidate` as MCP tools.

**What could not be verified, and why:**

- **Store lifecycle, capture, recall and supersession.** `iai_mcp.hippo` imports
  `numpy` at module load. `numpy>=1.26` is a declared hard dependency in the
  engine's `pyproject.toml` and is absent from its venv, which contains only
  `pip`. Nothing was installed to change that.
- **MCP over stdio.** The package has no `iai_mcp.__main__`; the server is
  reached through `iai_mcp.cli`. The adapter spawns that entry, but the
  handshake could not be exercised while `numpy` is missing.

**What the adapter does about it.** `IaiPersonalBackend` is built to the
documented protocol and every call is checked against the engine's own error
contract. An unreachable engine reports unavailability with a reason; a recall
yields nothing so an optional backend cannot break a session; a retain throws,
because a silently dropped memory is worse than a visible failure. Those paths
are tested with a command that cannot exist, so the degradation is proven
deterministically rather than assumed.

**How to close it:** install the engine's own declared dependencies in its venv
(`pip install -e .` in the engine checkout, or `pip install "numpy>=1.26,<2.3.0"`
`"scipy>=1.13.0"` `"numba>=0.59"`), then re-run the adapter against the live
engine: open a store on a temporary directory, capture, recall, contradict, and
assert the earlier record is archived rather than erased. Record encryption at
rest by inspecting the store files, without reading or logging any key.
