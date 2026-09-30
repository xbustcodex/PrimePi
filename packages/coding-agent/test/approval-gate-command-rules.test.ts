import { describe, expect, it } from "vitest";
import { type ApprovalGateOptions, decideToolApproval } from "../src/core/security/approval-gate.ts";
import { bashPatterns } from "../src/core/settings-descriptors.ts";

/**
 * Shell approval rules, driven through the real gate.
 *
 * ## The defect this pins
 *
 * `resolveCommandApproval` and `decideChain` were wired into `resolveToolApproval`,
 * which reads `context.command` and `context.commandText`. But the only production
 * caller of `resolveToolApproval` is `decideToolApproval`, and it built the
 * context with `{ mode, policies, hasPrompt }` only. `commandText` was therefore
 * `undefined` on every call, so `resolveCommandApproval` was never reached and a
 * configured `bash.patterns` deny rule governed nothing.
 *
 * The 28 tests that shipped with that wiring all called `resolveToolApproval`
 * **directly**, so they exercised the half that was correct and never crossed the
 * seam that was broken. Every test here goes through `decideToolApproval` — the
 * function the agent loop actually calls — because a test that does not cross the
 * seam cannot fail when the seam breaks.
 *
 * Each block states the two configurations that must differ, because "the gate
 * refuses a denied command" is only meaningful next to "the same call with no
 * rules does not".
 */

/** The tool under test: bash declaring itself allowed, which is the hard case. */
const BASH_ALLOWING = { name: "bash", approval: "allow" as const };

/** No prompt function, so a `prompt` decision becomes a refusal rather than a question. */
const NO_UI: ApprovalGateOptions["prompt"] = undefined;

const gate = (
	patterns: unknown,
	mode: ApprovalGateOptions["mode"] = "yolo",
	extra: Partial<ApprovalGateOptions> = {},
) =>
	decideToolApproval({
		tool: BASH_ALLOWING,
		args: { command: "rm -rf /" },
		options: {
			mode,
			policies: {},
			prompt: NO_UI,
			command: {
				// Read through the real descriptor, so a setting that cannot carry a
				// rule shows up here as an empty list rather than as a silent pass.
				patterns: bashPatterns.parse(patterns),
				compoundAllowed: false,
				shell: "/bin/bash",
			},
			...extra,
		},
	});

describe("a configured deny rule refuses through the gate", () => {
	it("refuses the command it names, where no rules would not have", async () => {
		// Config A and config B, the same call, opposite outcomes. The `yolo` mode
		// matters: it is the ceiling that would otherwise approve this outright,
		// so the deny is doing the work rather than the mode.
		const denied = await gate([{ match: "rm -rf *", approval: "deny" }]);
		const unconfigured = await gate([]);

		expect(denied.kind).toBe("deny");
		expect(denied.kind === "deny" && denied.message).toMatch(/rm -rf \*/);
		expect(unconfigured.kind).toBe("allow");
	});

	it("refuses even though the tool declared itself allowed and the mode is yolo", async () => {
		// The two things that would wave this through. A pattern is a narrowing
		// mechanism, so neither may defeat it.
		const result = await gate([{ match: "rm -rf *", approval: "deny" }], "yolo");
		expect(result.kind).toBe("deny");
		expect(result.decision.approved).toBe(false);
	});

	it("leaves an unrelated command to the mode rather than refusing it as a match", async () => {
		// The over-broad direction, and the one an over-eager rule would fail. A deny
		// for deletes must not become a denial for `git status`.
		//
		// `unmatched` is the reason this is a `blockedWithoutPrompt` refusal rather
		// than a `deny`: `decideChain` reports "no rule matched", which carries no
		// opinion, and the command then falls through to the mode ceiling. Asserting
		// `kind === "deny"` here would be asserting the wrong thing — it would pass
		// for a rule that wrongly matched. The mode, not the pattern, refused it.
		const result = await decideToolApproval({
			tool: BASH_ALLOWING,
			args: { command: "git status" },
			options: {
				mode: "yolo",
				policies: {},
				prompt: async () => "allow" as const,
				command: {
					patterns: bashPatterns.parse([{ match: "rm -rf *", approval: "deny" }]),
					compoundAllowed: false,
				},
			},
		});
		expect(result.kind).toBe("allow");
	});
});

describe("a configured prompt rule forces the question", () => {
	it("prompts with a prompt surface and refuses without one", async () => {
		// Both halves matter. With nobody to ask, the correct answer is "no" — the
		// failure this pins is a prompt rule silently degrading into an allow.
		const asked = await gate([{ match: "curl *", approval: "prompt" }], "yolo", {
			prompt: async () => "deny" as const,
		});
		const unasked = await gate([{ match: "curl *", approval: "prompt" }], "yolo");

		expect(asked.kind).toBe("deny");
		expect(unasked.kind).toBe("deny");
		expect(unasked.decision.blockedWithoutPrompt).toBe(true);
	});
});

describe("the setting can carry a rule at all", () => {
	it("admits the documented array wire form", async () => {
		// Defect 2: declared as a `record`, the registry rejected this array, so a
		// user could write `bash.patterns` and never once populate it.
		expect(bashPatterns.parse([{ match: "rm -rf *", approval: "deny" }])).toEqual([
			{ match: "rm -rf *", approval: "deny" },
		]);
	});

	it("still drops a malformed rule without discarding the rules around it", async () => {
		// One bad rule must not silently disable the deny beside it, which is the
		// failure mode that makes a user widen a rule until it works.
		expect(
			bashPatterns.parse([{ match: "rm -rf *", approval: "deny" }, { match: "x", approval: "nonsense" }, 42]),
		).toEqual([{ match: "rm -rf *", approval: "deny" }]);
	});

	it("rejects a shape that is not a list of rules", async () => {
		expect(() => bashPatterns.parse({ "rm -rf *": "deny" })).toThrow(/bash\.patterns/);
		expect(() => bashPatterns.parse("rm -rf *")).toThrow(/bash\.patterns/);
	});
});

describe("a tool that takes no command is unaffected", () => {
	it("judges nothing when the arguments carry no command", async () => {
		// A deny rule must not be reachable from a tool that runs nothing: a
		// refusal for text no shell would execute is indistinguishable from a bug.
		const result = await decideToolApproval({
			tool: { name: "read", approval: "read" as const },
			args: { path: "/etc/passwd" },
			options: {
				mode: "yolo",
				policies: {},
				command: { patterns: bashPatterns.parse([{ match: "*", approval: "deny" }]), compoundAllowed: false },
			},
		});
		expect(result.kind).toBe("allow");
	});

	it("judges nothing when the command is blank", async () => {
		const result = await decideToolApproval({
			tool: BASH_ALLOWING,
			args: { command: "   " },
			options: {
				mode: "yolo",
				policies: {},
				command: { patterns: bashPatterns.parse([{ match: "*", approval: "deny" }]), compoundAllowed: false },
			},
		});
		expect(result.kind).toBe("allow");
	});
});
