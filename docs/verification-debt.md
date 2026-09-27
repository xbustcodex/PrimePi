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
