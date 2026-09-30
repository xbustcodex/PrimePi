import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
	createToolDefinitionFromAgentTool,
	wrapToolDefinition,
} from "../src/core/tools/tool-definition-wrapper.ts";
import { resolveToolApproval } from "../src/core/security/tool-approval.ts";

/**
 * The tool projection must carry a tool's approval declaration.
 *
 * ## The defect this pins
 *
 * `wrapToolDefinition` copied name, label, description, parameters and the
 * behavioural fields, and silently dropped `approval`. The approval gate resolves
 * a tool's declared risk tier and policy from exactly that object, so the drop
 * made **every tool-declared tier and every `policy: "deny"` invisible** — rule 1
 * of `resolveToolApproval` was unreachable for every tool in the system, not just
 * for one badly configured tool.
 *
 * Found by MemoryRecall while integrating the auto-memory loop. Their probe
 * recorded the key set of a projected tool as
 * `name, label, description, parameters, constrainedSampling, prepareArguments,
 * executionMode, execute` with `hasApprovalKey: false`, and showed a tool
 * declaring `policy: "deny"` executing with a normal `"ran"` toolResult.
 *
 * Both directions matter: definition → AgentTool is the production path, and
 * AgentTool → definition is the path an extension override takes.
 */

const parameters = Type.Object({ x: Type.String() });

const definitionWith = (approval: unknown) => ({
	name: "guarded",
	label: "Guarded",
	description: "A tool that declares its own approval",
	parameters,
	...(approval === undefined ? {} : { approval }),
	execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }) as never,
});

const gate = (tool: ReturnType<typeof wrapToolDefinition>) =>
	resolveToolApproval(tool, {}, { mode: "yolo", policies: {}, hasPrompt: true });

describe("definition to AgentTool carries the approval declaration", () => {
	it("preserves an explicit deny", () => {
		// The load-bearing case. With `mode: yolo` the ceiling approves everything, so
		// only the tool's own declaration can refuse — which is exactly what the drop
		// made impossible.
		const tool = wrapToolDefinition(
			definitionWith({ tier: "exec", policy: "deny", reason: "forbidden" }) as never,
		);
		expect(gate(tool).policy).toBe("deny");
	});

	it("preserves a declared tier", () => {
		// Without the tier, every tool fell back to the default and `always-ask` saw
		// the same thing for a read and a mutation.
		const tool = wrapToolDefinition(definitionWith("exec") as never);
		expect(gate(tool).tier).toBe("exec");
		// Under `always-ask` the ceiling is `read`, so a preserved `exec` tier prompts
		// and a dropped one would silently allow. That difference is the assertion.
		const strict = resolveToolApproval(tool, {}, { mode: "always-ask", policies: {}, hasPrompt: true });
		expect(strict.policy).toBe("prompt");
	});

	it("preserves a policy alongside the tier", () => {
		const tool = wrapToolDefinition(definitionWith({ tier: "exec", policy: "allow" }) as never);
		// Under `always-ask` an explicit tool `allow` cannot outrank the mode.
		expect(resolveToolApproval(tool, {}, { mode: "always-ask", policies: {}, hasPrompt: true }).policy).toBe(
			"prompt",
		);
	});

	it("still carries the behavioural fields", () => {
		const definition = {
			...definitionWith(undefined),
			executionMode: "sequential" as const,
			constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
		};
		const tool = wrapToolDefinition(definition as never);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});

	it("omits the key entirely when the tool declares nothing", () => {
		// Not `approval: undefined` — an own key that is undefined is enough to make
		// a consumer believe a declaration exists.
		const tool = wrapToolDefinition(definitionWith(undefined) as never);
		expect(Object.hasOwn(tool, "approval")).toBe(false);
	});
});

describe("AgentTool to definition carries the approval declaration", () => {
	it("preserves a deny across the reverse projection", () => {
		// The path an extension-provided AgentTool override takes. Losing the field
		// here would reintroduce the same gap for a different class of tool.
		const original = wrapToolDefinition(
			definitionWith({ tier: "exec", policy: "deny", reason: "forbidden" }) as never,
		);
		const round = createToolDefinitionFromAgentTool(original);
		expect(resolveToolApproval(wrapToolDefinition(round as never), {}, { mode: "yolo", policies: {}, hasPrompt: true }).policy).toBe(
			"deny",
		);
	});

	it("preserves formatApprovalDetails", () => {
		const definition = {
			...definitionWith({ tier: "exec" }),
			formatApprovalDetails: () => ["detail line"],
		};
		const tool = wrapToolDefinition(definition as never);
		expect(tool.formatApprovalDetails?.({})).toEqual(["detail line"]);
		expect(createToolDefinitionFromAgentTool(tool).formatApprovalDetails).toBeDefined();
	});
});

describe("the gate still refuses when no tool declares anything", () => {
	it("falls back to the default tier rather than refusing", () => {
		// The fix must not turn an undeclared tool into a denied one: that would make
		// every extension tool unusable.
		const tool = wrapToolDefinition(definitionWith(undefined) as never);
		expect(gate(tool).policy).not.toBe("deny");
	});
});
