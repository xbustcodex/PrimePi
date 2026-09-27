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
