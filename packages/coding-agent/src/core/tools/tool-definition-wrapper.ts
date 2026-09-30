import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/**
 * Wrap a ToolDefinition into an AgentTool for the core runtime.
 *
 * ## `approval` is carried, and that is load-bearing
 *
 * This projection used to copy name/label/description/parameters and the
 * behavioural fields, and silently drop `approval`. The approval gate resolves a
 * tool's declared risk tier and policy from exactly this object, so dropping the
 * field made **every tool-declared tier and every `policy: "deny"` invisible to
 * the gate** — a tool declaring itself forbidden executed normally and left a
 * normal `"ran"` toolResult in the transcript.
 *
 * Found by MemoryRecall while integrating the auto-memory loop; see
 * `test/agent-tool-approval-projection.test.ts` for the regression.
 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		// Carried through. Without these the gate sees a tool with no declaration,
		// falls back to the default tier, and rule 1 of `resolveToolApproval` is
		// unreachable for every tool.
		...(definition.approval === undefined ? {} : { approval: definition.approval }),
		...(definition.formatApprovalDetails === undefined
			? {}
			: { formatApprovalDetails: definition.formatApprovalDetails }),
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 *
 * `approval` and `formatApprovalDetails` are carried in both directions for the same
 * reason as in {@link wrapToolDefinition}: a projection that drops them makes a
 * tool's declared tier and its `deny` unreachable from the approval gate.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		...(tool.approval === undefined ? {} : { approval: tool.approval }),
		...(tool.formatApprovalDetails === undefined ? {} : { formatApprovalDetails: tool.formatApprovalDetails }),
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
