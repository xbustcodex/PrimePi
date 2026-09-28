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
