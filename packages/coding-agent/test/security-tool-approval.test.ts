import type { ToolRiskTier } from "@earendil-works/pi-agent-core";
import { modeApprovesTier, TOOL_RISK_RANKS } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { type ApprovalGateOptions, decideToolApproval } from "../src/core/security/approval-gate.ts";
import {
	buildApprovalRequest,
	resolveToolApproval,
	resolveToolDeclaration,
	type ToolApprovalContext,
} from "../src/core/security/tool-approval.ts";
import {
	assertToolClassified,
	BUILT_IN_TOOL_TIERS,
	declarationForTool,
	tierForTool,
	unclassifiedTools,
} from "../src/core/security/tool-classification.ts";
import { allToolNames } from "../src/core/tools/index.ts";

/**
 * Tool approval.
 *
 * Three properties matter more than any individual decision, and each has its
 * own block below:
 *
 *  1. every tool is classified, so nothing is exempt by omission;
 *  2. deny is monotone — no configuration turns it into an allow;
 *  3. a required prompt with nobody to ask is a refusal, never an approval.
 */

function tool(name: string, approval?: unknown, extra: Record<string, unknown> = {}) {
	return { name, approval, ...extra } as never;
}

/**
 * Policy contexts for `resolveToolApproval`.
 *
 * `hasPrompt` is set because these describe a host that *can* ask; the
 * non-interactive path is exercised separately, where a required prompt becomes
 * a refusal.
 */
const YOLO: ToolApprovalContext = { mode: "yolo", policies: {}, hasPrompt: true };
const ASK: ToolApprovalContext = { mode: "always-ask", policies: {}, hasPrompt: true };
const WRITE_MODE: ToolApprovalContext = { mode: "write", policies: {}, hasPrompt: true };

/** Same three modes in the shape the gate takes. */
const GATE_YOLO: ApprovalGateOptions = { mode: "yolo", policies: {} };
const GATE_ASK: ApprovalGateOptions = { mode: "always-ask", policies: {} };
const GATE_WRITE: ApprovalGateOptions = { mode: "write", policies: {} };

describe("tool classification inventory", () => {
	it("classifies every tool Pi can register", () => {
		// The real registry, not a hand-written list, so a new built-in without a
		// classification fails here rather than silently escaping approval.
		expect(() => assertToolClassified([...allToolNames])).not.toThrow();
	});

	it("reports the complete built-in set", () => {
		expect(new Set(allToolNames)).toEqual(
			new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]),
		);
	});

	it("names every unclassified tool at once", () => {
		expect(unclassifiedTools(["read", "notATool", "alsoNotATool"])).toEqual(["notATool", "alsoNotATool"]);
	});

	it("throws when a tool is unclassified", () => {
		expect(() => assertToolClassified(["read", "mysteryTool"])).toThrow(/Unclassified tools: mysteryTool/);
	});

	it("tiers each built-in by what it can affect", () => {
		const expected: Record<string, ToolRiskTier> = {
			read: "read",
			ls: "read",
			grep: "read",
			find: "read",
			write: "write",
			edit: "write",
			bash: "exec",
			powershell: "exec",
		};
		for (const [name, tier] of Object.entries(expected)) {
			expect(tierForTool(tool(name))).toBe(tier);
		}
	});

	it("keeps search tools at read despite spawning a process", () => {
		// grep and find run `rg`/`fd`, but their argv is fixed and read-only. Tiering
		// them by "spawns a process" would make ordinary searching require approval.
		expect(BUILT_IN_TOOL_TIERS.grep).toBe("read");
		expect(BUILT_IN_TOOL_TIERS.find).toBe("read");
	});

	it("falls back to the most privileged tier for an unknown tool", () => {
		expect(tierForTool(tool("somethingNew"))).toBe("exec");
		expect(declarationForTool(tool("somethingNew"))).toBe("exec");
	});

	it("prefers a tool's own declaration over the table", () => {
		expect(tierForTool(tool("read", "write"))).toBe("write");
	});
});

describe("risk hierarchy and policy ordering", () => {
	it("auto-approves up to the mode ceiling and prompts above it", () => {
		// always-ask: read passes, write prompts.
		expect(resolveToolApproval(tool("x", "read"), {}, ASK).policy).toBe("allow");
		expect(resolveToolApproval(tool("x", "write"), {}, ASK).policy).toBe("prompt");
		expect(resolveToolApproval(tool("x", "exec"), {}, ASK).policy).toBe("prompt");

		// write mode: read and write pass, exec prompts.
		expect(resolveToolApproval(tool("x", "read"), {}, WRITE_MODE).policy).toBe("allow");
		expect(resolveToolApproval(tool("x", "write"), {}, WRITE_MODE).policy).toBe("allow");
		expect(resolveToolApproval(tool("x", "exec"), {}, WRITE_MODE).policy).toBe("prompt");

		// yolo: everything passes.
		expect(resolveToolApproval(tool("x", "exec"), {}, YOLO).policy).toBe("allow");
	});

	it("lets a user policy require a prompt below the ceiling", () => {
		const decided = resolveToolApproval(
			tool("x", "read"),
			{},
			{
				mode: "yolo",
				policies: { x: "prompt" },
				hasPrompt: true,
			},
		);
		expect(decided.policy).toBe("prompt");
		expect(decided.source).toBe("user");
	});

	it("orders tiers read < write < exec", () => {
		expect(TOOL_RISK_RANKS.read).toBeLessThan(TOOL_RISK_RANKS.write);
		expect(TOOL_RISK_RANKS.write).toBeLessThan(TOOL_RISK_RANKS.exec);
		expect(modeApprovesTier("always-ask", "read")).toBe(true);
		expect(modeApprovesTier("always-ask", "write")).toBe(false);
		expect(modeApprovesTier("write", "write")).toBe(true);
		expect(modeApprovesTier("write", "exec")).toBe(false);
		expect(modeApprovesTier("yolo", "exec")).toBe(true);
	});

	it("does not let a tool's own allow defeat a stricter mode", () => {
		// `write` is above the `always-ask` ceiling of `read`, so the tool's own
		// `allow` must not carry it through.
		const decided = resolveToolApproval(tool("x", { tier: "write", policy: "allow" }), {}, ASK);
		expect(decided.policy).toBe("prompt");
	});

	it("lets a user allow override a stricter mode", () => {
		const decided = resolveToolApproval(
			tool("x", "write"),
			{},
			{
				mode: "always-ask",
				policies: { x: "allow" },
				hasPrompt: true,
			},
		);
		expect(decided.policy).toBe("allow");
		expect(decided.source).toBe("user");
	});
});

describe("deny is monotone", () => {
	it("refuses a tool-declared deny under every mode", async () => {
		for (const options of [ASK, WRITE_MODE, YOLO]) {
			const result = await decideToolApproval({
				tool: tool("x", { tier: "exec", policy: "deny" }),
				args: {},
				options,
			});
			expect(result.kind).toBe("deny");
		}
	});

	it("refuses even when a user policy allows and the mode is yolo", async () => {
		const result = await decideToolApproval({
			tool: tool("x", { tier: "exec", policy: "deny" }),
			args: {},
			options: { mode: "yolo", policies: { x: "allow" } },
		});
		expect(result.kind).toBe("deny");
	});

	it("refuses a user-declared deny under every mode", async () => {
		for (const options of [GATE_YOLO, GATE_WRITE, GATE_ASK]) {
			const result = await decideToolApproval({
				tool: tool("x", "exec"),
				args: {},
				options: { ...options, policies: { x: "deny" } },
			});
			expect(result.kind).toBe("deny");
		}
	});

	it("distinguishes a tool denial from a user denial in the message", async () => {
		const toolDeny = await decideToolApproval({
			tool: tool("x", { tier: "exec", policy: "deny", reason: "unsafe" }),
			args: {},
			options: GATE_YOLO,
		});
		const userDeny = await decideToolApproval({
			tool: tool("y", "exec"),
			args: {},
			options: { mode: "yolo", policies: { y: "deny" } },
		});
		expect(toolDeny.kind === "deny" && toolDeny.message).toContain("tool policy");
		expect(toolDeny.kind === "deny" && toolDeny.message).toContain("unsafe");
		expect(userDeny.kind === "deny" && userDeny.message).toContain("user policy");
	});

	it("consults a nominated sub-capability key", () => {
		const decided = resolveToolApproval(
			tool("x", { tier: "exec", policyKey: "x:danger" }),
			{},
			{
				mode: "yolo",
				policies: { "x:danger": "deny" },
				hasPrompt: true,
			},
		);
		expect(decided.policy).toBe("deny");
		expect(decided.policyKey).toBe("x:danger");
	});
});

describe("non-interactive behaviour", () => {
	it("refuses a required prompt when there is nobody to ask", async () => {
		const result = await decideToolApproval({
			tool: tool("x", "exec"),
			args: {},
			options: { mode: "always-ask", policies: {} },
		});
		expect(result.kind).toBe("deny");
		if (result.kind !== "deny") throw new Error("expected a denial");
		expect(result.decision.blockedWithoutPrompt).toBe(true);
		expect(result.message).toContain("no interactive surface");
	});

	it("never converts a missing prompt into approval", async () => {
		// Every mode, every tier above the ceiling: the answer is always "deny".
		for (const mode of ["always-ask", "write"] as const) {
			for (const tier of ["write", "exec"] as const) {
				if (mode === "write" && tier === "write") continue;
				const result = await decideToolApproval({
					tool: tool("x", tier),
					args: {},
					options: { mode, policies: {} },
				});
				expect(result.kind).toBe("deny");
			}
		}
	});

	it("treats a prompt that throws as a refusal, not a grant", async () => {
		const result = await decideToolApproval({
			tool: tool("x", "exec"),
			args: {},
			options: {
				mode: "always-ask",
				policies: {},
				prompt: async () => {
					throw new Error("dialog unavailable");
				},
			},
		});
		expect(result.kind).toBe("deny");
		expect(result.decision.blockedWithoutPrompt).toBe(true);
	});

	it("honours an explicit allow from a working prompt", async () => {
		const result = await decideToolApproval({
			tool: tool("x", "exec"),
			args: {},
			options: { ...GATE_ASK, prompt: async () => "allow" },
		});
		expect(result.kind).toBe("allow");
		expect(result.decision.approved).toBe(true);
	});

	it("honours an explicit deny from a working prompt", async () => {
		const result = await decideToolApproval({
			tool: tool("x", "exec"),
			args: {},
			options: { ...GATE_ASK, prompt: async () => "deny" },
		});
		expect(result.kind).toBe("deny");
		expect(result.decision.approved).toBe(false);
	});

	it("asks exactly one question per gated call", async () => {
		const prompt = vi.fn(async () => "allow" as const);
		await decideToolApproval({ tool: tool("x", "exec"), args: {}, options: { ...ASK, prompt } });
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("does not ask at all when the decision is already allow", async () => {
		const prompt = vi.fn(async () => "allow" as const);
		await decideToolApproval({ tool: tool("x", "read"), args: {}, options: { ...ASK, prompt } });
		expect(prompt).not.toHaveBeenCalled();
	});
});

describe("approval request contract", () => {
	it("carries the tool, tier, and arguments for any surface to render", async () => {
		let seen: { toolName: string; tier: ToolRiskTier; args: unknown } | undefined;
		await decideToolApproval({
			tool: tool("bash", "exec", { formatApprovalDetails: () => ["runs: rm -rf /"] }),
			args: { command: "rm -rf /" },
			options: {
				mode: "always-ask",
				policies: {},
				prompt: async (request) => {
					seen = { toolName: request.toolName, tier: request.tier, args: request.args };
					return "deny";
				},
			},
		});
		expect(seen?.toolName).toBe("bash");
		expect(seen?.tier).toBe("exec");
		expect(seen?.args).toEqual({ command: "rm -rf /" });
	});

	it("includes the tool's own detail lines", () => {
		const request = buildApprovalRequest(
			tool("bash", "exec", {
				formatApprovalDetails: (args: unknown) => [`cmd: ${(args as { command: string }).command}`],
			}),
			{ command: "ls" },
			resolveToolApproval(tool("bash", "exec"), {}, ASK),
		);
		expect(request.details).toEqual(["cmd: ls"]);
	});

	it("drops blank detail lines rather than passing them to a UI", () => {
		const request = buildApprovalRequest(
			tool("x", "exec", { formatApprovalDetails: () => ["ok", "", "   ", "more"] }),
			{},
			resolveToolApproval(tool("x", "exec"), {}, ASK),
		);
		expect(request.details).toEqual(["ok", "more"]);
	});

	it("survives a tool whose detail formatter throws", () => {
		const request = buildApprovalRequest(
			tool("x", "exec", {
				formatApprovalDetails: () => {
					throw new Error("boom");
				},
			}),
			{},
			resolveToolApproval(tool("x", "exec"), {}, ASK),
		);
		expect(request.toolName).toBe("x");
	});
});

describe("declaration resolution fails closed", () => {
	it("treats a throwing declaration as the most privileged tier", () => {
		const declaration = resolveToolDeclaration(
			tool("x", () => {
				throw new Error("cannot describe self");
			}),
			{},
		);
		expect(declaration).toBe("exec");
	});

	it("rejects an unknown tier value", () => {
		expect(resolveToolDeclaration(tool("x", "catastrophic"), {})).toBe("exec");
		expect(resolveToolDeclaration(tool("x", { tier: "nonsense" as never }), {})).toBe("exec");
	});

	it("rejects an unknown policy value", () => {
		expect(resolveToolDeclaration(tool("x", { tier: "exec", policy: "maybe" as never }), {})).toBe("exec");
	});

	it("defaults an undeclared tool to the most privileged tier", () => {
		expect(resolveToolDeclaration(tool("x"), {})).toBe("exec");
	});

	it("uses an argument-dependent declaration when supplied", () => {
		expect(
			resolveToolDeclaration(
				tool("x", (args: unknown) => ((args as { risky: boolean }).risky ? "exec" : "read")),
				{ risky: false },
			),
		).toBe("read");
		expect(
			resolveToolDeclaration(
				tool("x", (args: unknown) => ((args as { risky: boolean }).risky ? "exec" : "read")),
				{ risky: true },
			),
		).toBe("exec");
	});
});
