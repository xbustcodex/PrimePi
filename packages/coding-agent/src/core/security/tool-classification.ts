/**
 * Tool classification.
 *
 * Every tool Pi can invoke is listed here with a risk tier, so there is no
 * execution path that is exempt from approval merely because nobody classified
 * it. The registry is the *inventory*; the policy in `tool-approval.ts` reads
 * the tier from the tool itself, and this table is what guarantees the two
 * cannot drift.
 *
 * ## Why a table and not inference
 *
 * A tier could in principle be derived from what a tool touches, but that
 * inference would be wrong in both directions. `grep` spawns a subprocess and is
 * still read-only; `write` touches one file and is more consequential than a
 * `ls` of a thousand. The tier is a judgement about consequences, so it is
 * written down as one.
 *
 * ## The two invariants this file maintains
 *
 * 1. **Completeness.** `assertToolClassified` fails loudly for an unknown tool.
 *    An unclassified tool is a question the security layer cannot answer, and
 *    answering it with "probably fine" is how gaps become bypasses.
 * 2. **Fail-closed default.** Even if a tool is somehow not in the table, its
 *    effective tier is `exec` (see `MAX_TOOL_RISK_TIER`), so the fallback is the
 *    most restrictive answer rather than the most permissive.
 */

import type { ToolApproval, ToolApprovalDeclaration, ToolRiskTier } from "@earendil-works/pi-agent-core";
import type { ApprovableTool } from "./tool-approval.ts";

/**
 * Risk tier per built-in tool.
 *
 * The tiers mean:
 * - `read` — discloses existing content, changes nothing.
 * - `write` — changes the filesystem.
 * - `exec` — runs a program, and what that program does is not constrained by
 *   the tool's own code.
 *
 * `grep` and `find` are `read` despite spawning `rg`/`fd`: their argv is fixed
 * and read-only, and a search cannot modify what it searches. They are
 * nonetheless worth naming explicitly here, because "spawns a process" is
 * exactly the reasoning that would otherwise misclassify them upward and
 * quietly make ordinary searching require approval.
 */
export const BUILT_IN_TOOL_TIERS: Readonly<Record<string, ToolRiskTier>> = Object.freeze({
	// Filesystem reads.
	read: "read",
	ls: "read",
	grep: "read",
	find: "read",

	// Filesystem writes. `edit` is bounded to the files it names, which is what
	// separates it from `exec`.
	write: "write",
	edit: "write",

	// Process execution. Unconstrained by construction: nothing the tool's own
	// code does constrains what the spawned program can do.
	bash: "exec",
	powershell: "exec",

	// Session-state writes.
	//
	// `todo` mutates structured progress state, so it is write class rather than
	// OMP's `read`, which the trace found passes through no approval gate in any
	// mode. It is deliberately not `exec`: it runs nothing, and an `exec` tier
	// would make routine progress tracking unusable under a strict approval mode.
	todo: "write",

	// Delegation.
	//
	// `task` is `exec`, matching OMP's own classification. It can start a child
	// that runs tools, so it can change the world — which means it is gated by
	// exactly the same authority as `bash`, and is refused by the same Plan Mode
	// barrier. Being an orchestration tool grants it no exemption: the child's
	// calls are re-decided by the parent's gate rather than inherited.
	task: "exec",
});

/** A tool classification entry, kept as a declaration so policy and tier stay together. */
export type ToolClassification = {
	tier: ToolRiskTier;
	/** Set when the declaration carries more than a bare tier. */
	declaration?: ToolApprovalDeclaration;
};

/**
 * Classifications for tools that need more than a tier.
 *
 * Kept separate from the table above because these carry a policy, and a
 * blanket tier alone would not express the difference between "dangerous" and
 * "dangerous and unwilling".
 */
const TOOL_DECLARATIONS: Readonly<Record<string, ToolApprovalDeclaration>> = Object.freeze({
	// Both shells are unconstrained: a tier of `exec` is the honest description,
	// and neither may be auto-approved by anything short of `yolo`.
	bash: "exec",
	powershell: "exec",
});

/**
 * The declaration a tool should be treated as having, whether it declared one.
 *
 * A tool that declared its own approval keeps it — the tool author knows their
 * tool best. A tool that did not is classified from the table, so a new built-in
 * is not automatically the most privileged thing in the system just because
 * nobody filled in a field.
 */
export function declarationForTool(tool: ApprovableTool): ToolApproval {
	if (tool.approval !== undefined) return tool.approval;
	const declared = TOOL_DECLARATIONS[tool.name];
	if (declared !== undefined) return declared;
	const tier = BUILT_IN_TOOL_TIERS[tool.name];
	return tier ?? "exec";
}

/**
 * The effective tier for a tool, without resolving its arguments.
 *
 * Argument-dependent declarations still answer here, because a function-valued
 * declaration has no tier until it is called; in that case this reports the
 * most privileged tier rather than guessing, and the real resolution happens
 * in `resolveToolApproval` with the actual arguments.
 */
export function tierForTool(tool: ApprovableTool): ToolRiskTier {
	const declaration = declarationForTool(tool);
	// A function-valued declaration has no tier until it is called against real
	// arguments, so this reports the most privileged tier rather than guessing.
	if (typeof declaration === "function") return "exec";
	return typeof declaration === "string" ? declaration : declaration.tier;
}

/**
 * Names of tools with no classification.
 *
 * Returns an array rather than throwing so a caller can report every gap at
 * once instead of one per run.
 */
export function unclassifiedTools(toolNames: readonly string[]): string[] {
	return toolNames.filter((name) => BUILT_IN_TOOL_TIERS[name] === undefined);
}

/**
 * Fails when a registered tool has no classification.
 *
 * Intended for a test that runs against the real registry, so adding a tool
 * without classifying it is a test failure rather than a silent gap.
 */
export function assertToolClassified(toolNames: readonly string[]): void {
	const missing = unclassifiedTools(toolNames);
	if (missing.length > 0) {
		throw new Error(
			`Unclassified tools: ${missing.join(", ")}. ` +
				`Every tool must appear in BUILT_IN_TOOL_TIERS so the approval authority can classify it.`,
		);
	}
}
