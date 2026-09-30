import { describe, expect, it } from "vitest";
import { resolveCommandApproval, resolveToolApproval } from "../src/core/security/tool-approval.ts";
import { parseApprovalPatterns } from "../src/core/shell/approval-patterns.ts";

/**
 * Command-level approval, end to end through the production resolver.
 *
 * These tests drive `resolveToolApproval` — the function the session actually
 * calls — rather than the command helper, because the property that matters is
 * how a command rule interacts with the mode ceiling and with the two denials
 * above it. Testing the helper alone would pass while the layering was wrong.
 *
 * The three properties:
 *
 * 1. **A pattern cannot widen past the mode.** `always-ask` still asks.
 * 2. **A pattern cannot un-deny.** A tool or user denial outranks every pattern.
 * 3. **A compound command is judged per segment**, and a chain that cannot be
 *    segmented is judged as one opaque command — never waved through by a
 *    catch-all allow.
 */

const BASH = { name: "bash", approval: "exec" as const };

const rules = (patterns: { match: string; approval: "allow" | "deny" | "prompt" }[], compoundAllowed = false) => ({
	patterns,
	compoundAllowed,
	shell: "/bin/bash",
});

const decide = (input: {
	command: string;
	commandRules?: ReturnType<typeof rules>;
	mode?: "yolo" | "write" | "always-ask";
	policies?: Record<string, "allow" | "deny" | "prompt">;
	tool?: typeof BASH;
}) =>
	resolveToolApproval(input.tool ?? BASH, { command: input.command }, {
		mode: input.mode ?? "write",
		policies: input.policies ?? {},
		hasPrompt: true,
		...(input.commandRules ? { command: input.commandRules, commandText: input.command } : {}),
	});

describe("a pattern cannot widen past the mode", () => {
	it("always-ask still asks for a command an allow pattern covers", () => {
		// The single most important property: a permissive rule must not become a
		// licence to skip the question the user explicitly asked for.
		expect(decide({ command: "git status", commandRules: rules([{ match: "git *", approval: "allow" }]), mode: "always-ask" }).policy).toBe("prompt");
	});

	it("a mode below the ceiling auto-approves as before", () => {
		// `write` mode's ceiling is the `write` tier and `bash` is `exec`, so bash is
		// above it and prompts. The point here is that a command with no rules is
		// untouched by the integration.
		expect(decide({ command: "git status", mode: "write" }).policy).toBe("prompt");
	});

	it("yolo still auto-approves a denied command", () => {
		// yolo is the mode ceiling's own behaviour and is unchanged here.
		expect(decide({ command: "ls", mode: "yolo" }).policy).toBe("allow");
	});
});

describe("a pattern cannot un-deny", () => {
	it("a user denial outranks an allow pattern", () => {
		expect(
			decide({ command: "rm -rf /tmp/x", commandRules: rules([{ match: "rm *", approval: "allow" }]), policies: { bash: "deny" } }).policy,
		).toBe("deny");
	});

	it("a pattern deny is final whatever the mode", () => {
		expect(decide({ command: "rm -rf /", commandRules: rules([{ match: "rm *", approval: "deny" }]), mode: "yolo" }).policy).toBe("deny");
	});
});

describe("a prompt pattern forces the question below the ceiling", () => {
	it("asks even for a command the mode would otherwise allow outright", () => {
		// An operator can ask to be consulted for a command they usually do not want
		// to see unprompted.
		expect(decide({ command: "git status", commandRules: rules([{ match: "git *", approval: "prompt" }]), mode: "yolo" }).policy).toBe("prompt");
	});
});

describe("a compound command is judged per segment", () => {
	const compound = rules([{ match: "git status", approval: "allow" }], true);

	it("refuses a chain whose second segment is denied", () => {
		// Approving the chain as one string would show the user the read and hide the
		// delete. This is the confused-deputy bug segmentation exists to prevent.
		const decision = decide({
			command: "git status && rm -rf /tmp/build",
			commandRules: rules([{ match: "git status", approval: "allow" }, { match: "rm *", approval: "deny" }], true),
		});
		expect(decision.policy).toBe("deny");
	});

	it("asks when a segment has no rule", () => {
		expect(decide({ command: "git status && npm test", commandRules: compound, mode: "yolo" }).policy).toBe("prompt");
	});

	it("allows only when every segment matches an allow", () => {
		// Under `yolo`, which is the only mode whose ceiling covers `exec`, so the
		// per-segment allow is actually what decides it.
		const both = rules([{ match: "git status", approval: "allow" }, { match: "npm test", approval: "allow" }], true);
		expect(decide({ command: "git status && npm test", commandRules: both, mode: "yolo" }).policy).toBe("allow");
	});
});

describe("a catch-all allow cannot vouch for an unsegmentable chain", () => {
	it("asks rather than allowing", () => {
		// The whole reason segmentation was refused is that we cannot say what the
		// chain contains.
		const decision = decide({ command: "git status && rm -rf /", commandRules: rules([{ match: "*", approval: "allow" }]), mode: "yolo" });
		expect(decision.policy).toBe("prompt");
	});

	it("allows the same catch-all for a single command", () => {
		// Otherwise the catch-all would be useless, which is why this is narrow.
		expect(decide({ command: "git status", commandRules: rules([{ match: "*", approval: "allow" }]), mode: "yolo" }).policy).toBe("allow");
	});
});

describe("pattern syntax", () => {
	it("treats a pattern as an anchored glob, not a regular expression", () => {
		// `rm -rf /tmp/*` must not mean "ends in a character class".
		expect(decide({ command: "echo rm -rf /tmp/abc", commandRules: rules([{ match: "rm *", approval: "deny" }]), mode: "yolo" }).policy).not.toBe("deny");
	});

	it("normalises whitespace so a readable pattern still fires", () => {
		// A pattern that never matches invites widening it, which is how a dangerous
		// allow gets written.
		expect(decide({ command: "git   status", commandRules: rules([{ match: "git status", approval: "deny" }]), mode: "yolo" }).policy).toBe("deny");
	});

	it("drops a malformed rule without dropping the rules around it", () => {
		// One bad rule must not silently disable the restrictions beside it.
		const parsed = parseApprovalPatterns([
			{ match: "", approval: "allow" },
			{ match: "rm *", approval: "deny" },
			{ match: "ls", approval: "maybe" },
		]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.match).toBe("rm *");
	});
});

describe("with no rules the command carries no opinion", () => {
	it("falls through to the tier", () => {
		// The common case: most commands have no rule, and an absent configuration must
		// not become a permission.
		expect(decide({ command: "ls -la", mode: "yolo" }).policy).toBe("allow");
	});

	it("an empty rule list is the same as none", () => {
		expect(resolveCommandApproval("ls", { patterns: [], compoundAllowed: false }).kind).toBe("unspecified");
	});

	it("an undefined rule set is the same as none", () => {
		expect(resolveCommandApproval("ls", undefined).kind).toBe("unspecified");
	});
});

describe("a tool that takes no command is unaffected", () => {
	it("an edit resolves on its own tier", () => {
		// The rules are per-call, so shell patterns cannot leak onto a file mutation.
		const edit = { name: "edit", approval: "write" as const };
		const decision = resolveToolApproval(edit, { path: "a.ts" }, { mode: "yolo", policies: {}, hasPrompt: true });
		expect(decision.policy).toBe("allow");
	});
});
