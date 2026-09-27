/**
 * The planning-phase write barrier.
 *
 * ## Where OMP puts it, and why this is different
 *
 * OMP enforces plan mode's read-only guarantee in **three scattered places**:
 * `enforcePlanModeWrite` called from four sites inside `tools/write.ts`
 * (`:777`, `:814`, `:842`, `:859`), an `EditPolicy.planActive` flag handed to the
 * native editor (`edit/index.ts:609`), and a `SchemeWriteScope` taxonomy
 * (`internal-urls/types.ts:74`). `bash` is not restricted mechanically at all —
 * that rule is prompt-only.
 *
 * Three consequences, all of which this module avoids:
 *
 * 1. A new write path that forgets the call silently escapes the barrier.
 * 2. The same rule is expressed three times and can drift.
 * 3. `bash` is exempt, so the guarantee the user is told about is not the
 *    guarantee they get.
 *
 * ## What this does instead
 *
 * The barrier is expressed as an **approval decision**, evaluated at the one
 * place Pi already has: the `beforeToolCall` gate installed by Phase 3. A tool
 * does not opt in, cannot opt out, and needs no knowledge that plan mode exists.
 *
 * That is a stronger guarantee, and it is why the barrier belongs here rather than
 * in a tool: `deny` short-circuits before `execute` is reached, so the underlying
 * side effect never happens. A barrier implemented inside a tool would be
 * advisory — the tool would already be running.
 */

import type { ToolApprovalDeclaration, ToolRiskTier } from "@earendil-works/pi-agent-core";
import { isWriteBarrierActive, type PlanState } from "./plan-state.ts";

/**
 * Where a write is allowed to land while planning.
 *
 * Mirrors OMP's `SchemeWriteScope` idea without its taxonomy: the plan artifact
 * area is writable, the working tree is not. Kept as a single predicate so the
 * rule exists once.
 */
export type PlanWriteTarget =
	/** The plan artifact the agent is drafting. */
	| "plan-artifact"
	/** The user's working tree. */
	| "workspace"
	/** Anything else, including a path that cannot be classified. */
	| "unknown";

/**
 * Classifies a write target relative to the plan artifact area.
 *
 * Fails toward `workspace`: an unclassifiable path is treated as the working
 * tree, so a novel URL scheme cannot be used to reach a write by being
 * unrecognized.
 */
export function classifyWriteTarget(input: { targetPath: string; planArtifactPrefix: string }): PlanWriteTarget {
	const path = input.targetPath.trim();
	if (path.startsWith(input.planArtifactPrefix)) return "plan-artifact";
	if (path === "" || path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return "workspace";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return "unknown";
	return "workspace";
}

/**
 * The tier a tool is promoted to while the barrier is up.
 *
 * A tool whose own tier is `read` stays `read` — the agent must be able to explore
 * to construct a plan. Everything else is treated as `exec`, the most privileged
 * tier, so the mode ceiling cannot auto-approve it under any policy short of
 * `yolo`, and even then the explicit `deny` below still wins.
 */
export function planningTierFor(baseTier: ToolRiskTier): ToolRiskTier {
	return baseTier === "read" ? "read" : "exec";
}

/**
 * The declaration the approval authority should use while planning.
 *
 * Returns `undefined` when the barrier is down, so the normal path is completely
 * untouched — a caller can spread this and get the tool's own declaration.
 *
 * The returned `deny` is unconditional and tool-declared, which is the one
 * decision Phase 3 guarantees no mode or user policy can override. That is what
 * makes the barrier a guarantee rather than a suggestion.
 */
export function planningApprovalDeclaration(input: {
	planState: PlanState;
	baseDeclaration: ToolApprovalDeclaration | undefined;
	baseTier: ToolRiskTier;
	planArtifactPrefix: string;
	targetPath?: string;
}): ToolApprovalDeclaration | undefined {
	if (!isWriteBarrierActive(input.planState)) return undefined;

	// Reads and exploration are never restricted: constructing a plan requires
	// them, and OMP keeps the full pre-plan tool set for the same reason.
	if (input.baseTier === "read") return undefined;

	const target = classifyWriteTarget({
		targetPath: input.targetPath ?? "",
		planArtifactPrefix: input.planArtifactPrefix,
	});

	// Writing the plan itself is the one thing planning must be able to do.
	if (target === "plan-artifact") {
		return { tier: planningTierFor(input.baseTier), policy: "allow" };
	}

	return {
		tier: planningTierFor(input.baseTier),
		policy: "deny",
		reason:
			target === "workspace"
				? "Plan mode: the working tree is read-only while planning. Write the plan artifact instead."
				: "Plan mode: that target is not writable while planning. Write the plan artifact instead.",
	};
}

/**
 * The path a tool call would write to, or `undefined` when it names none.
 *
 * Read from the arguments rather than declared per tool, so a tool with an
 * unfamiliar argument name is classified as `unknown` — which the caller treats
 * as non-writable — instead of escaping the barrier by not being recognized.
 *
 * `bash` and `powershell` return `undefined` on purpose: they are `exec` and
 * always refused while planning, so there is no path worth extracting. This is
 * the gap in OMP, where a shell command is unrestricted during planning.
 */
export function extractWriteTargetPath(toolName: string, args: unknown): string | undefined {
	if (toolName === "bash" || toolName === "powershell") return undefined;
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;

	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "target"]) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}
