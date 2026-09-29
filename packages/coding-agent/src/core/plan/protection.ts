/**
 * Plan mode: the read-only phase before execution, and the protection its file
 * needs.
 *
 * ## What plan mode is
 *
 * A session starts read-only. The agent explores, and produces a plan. The plan
 * is approved, and only then does execution begin.
 *
 * The read-only part is the point. It is what stops an agent from editing three
 * files while still deciding what the change should be, and it is what makes the
 * plan something the *user* agreed to rather than something that happened to them.
 *
 * ## Why the plan file needs compaction protection
 *
 * A plan is a read result, and read results are exactly what pruning and shaking
 * remove first — they are the oldest and least token-dense content in a
 * transcript.
 *
 * That is backwards for a plan. The plan is the one document the whole
 * execution phase depends on, and a session that compacts halfway through
 * implementation and loses the plan has lost the thread without anything
 * visibly going wrong. So the plan's read is protected, on the same footing as a
 * skill read.
 *
 * ## Both names are matched, and the reference is read at match time
 *
 * A plan can be read by the canonical alias or by the agent-chosen name it was
 * saved under, and either must survive. The reference path is a *function*, so a
 * plan approved mid-session is protected from the next prune onward rather than
 * from the next restart.
 */

import path from "node:path";

/** The alias every session's local root resolves for its plan. */
export const LOCAL_PLAN_ALIAS = "local://PLAN.md";

/** The minimum a read must look like for the protection to consider it. */
export interface ProtectedToolContext {
	readonly toolResult: { readonly toolName: string };
	readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> } | undefined;
}

/** The `path` argument of a paired `read` call. */
export function getReadToolPath(context: ProtectedToolContext): string | undefined {
	if (context.toolResult.toolName !== "read" || context.toolCall?.name !== "read") return undefined;
	const value = context.toolCall.arguments.path;
	return typeof value === "string" ? value : undefined;
}

/**
 * Normalises an internal URL for comparison.
 *
 * `local:/PLAN.md` and `local://PLAN.md` name the same thing, and a trailing read
 * selector - `:1-50`, `:raw` - is not part of the identity. Comparing the raw
 * strings would let a plan read with a selector evade its own protection, which is
 * the failure this normalisation exists to prevent.
 */
export function normalizePlanUrl(value: string): string {
	let normalized = value.trim();
	// Collapse `local:/` to `local://` without touching a path that is already
	// double-slashed.
	normalized = normalized.replace(/^local:\/(?!\/)/i, "local://");
	// Drop a read selector, keeping the path. Only the final segment can carry one.
	const lastSlash = normalized.lastIndexOf("/");
	const tail = normalized.slice(lastSlash + 1);
	const selectorAt = tail.indexOf(":");
	if (selectorAt >= 0) normalized = normalized.slice(0, lastSlash + 1) + tail.slice(0, selectorAt);
	return normalized;
}

/** Whether a read path targets a given plan target. */
export function readTargetsPlan(readPath: string, planTarget: string): boolean {
	const read = normalizePlanUrl(readPath);
	const target = normalizePlanUrl(planTarget);
	// The selector case is already handled by normalisation, so this only has to
	// cover an exact match and a path that legitimately sits under the target.
	return read === target || read.startsWith(`${target}:`);
}

/**
 * Builds the protection matcher for a session's plan.
 *
 * `getPlanReferencePath` is evaluated at match time, so a plan approved during
 * the session is protected from the next prune onward rather than from the next
 * restart.
 */
export function createPlanReadMatcher(getPlanReferencePath: () => string): (context: ProtectedToolContext) => boolean {
	return (context: ProtectedToolContext) => {
		const readPath = getReadToolPath(context);
		if (readPath === undefined) return false;
		return readTargetsPlan(readPath, LOCAL_PLAN_ALIAS) || readTargetsPlan(readPath, getPlanReferencePath());
	};
}

/** A plan's file name, derived from a title. */
export function planFileName(title: string): string {
	const slug = title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	// A title of nothing but punctuation still has to produce a usable file name,
	// or an approved plan has nowhere to live.
	return slug.length > 0 ? `${slug}-plan.md` : "plan.md";
}

/** Where an approved plan is written, under the project's directory. */
export function resolvePlanFilePath(cwd: string, title: string, directory = ".omp/plans"): string {
	return path.join(cwd, directory, planFileName(title));
}

/** A plan title, taken from what was supplied or derived from its content. */
export function resolvePlanTitle(input: { suppliedTitle?: unknown; planContent: string; planFilePath: string }): {
	title: string;
	source: "supplied" | "content" | "filename";
} {
	const supplied = typeof input.suppliedTitle === "string" ? input.suppliedTitle.trim() : "";
	if (supplied.length > 0) return { title: supplied, source: "supplied" };
	// A heading is the plan author's own name for it, which beats anything derived
	// from the file it happens to be saved under.
	const heading = input.planContent.split("\n").find((line) => /^#{1,3}\s+\S/.test(line.trim()));
	if (heading) {
		const title = heading.replace(/^#{1,3}\s+/, "").trim();
		if (title.length > 0) return { title, source: "content" };
	}
	// Falling back to the file's own name is better than an empty title, which
	// would produce `plan.md` for every plan in a project.
	const fromName = path.basename(input.planFilePath, ".md").replace(/-plan$/, "");
	return { title: fromName.length > 0 ? fromName : "plan", source: "filename" };
}

/**
 * Whether execution may begin.
 *
 * A plan is approved, or there was never one. Both are legitimate, and the
 * distinction is what makes the transition explicit rather than a silent change
 * of mode.
 */
export function mayBeginExecution(input: {
	planModeEnabled: boolean;
	planModeActive: boolean;
	planApproved: boolean;
}): { allowed: boolean; reason: string } {
	if (!input.planModeEnabled) {
		// The feature is off, so there is nothing to gate. A session that never
		// enabled plan mode must not be stuck waiting for an approval.
		return { allowed: true, reason: "plan mode is not enabled" };
	}
	if (!input.planModeActive) return { allowed: true, reason: "plan mode is not active" };
	if (input.planApproved) return { allowed: true, reason: "the plan is approved" };
	return { allowed: false, reason: "plan mode is active and the plan has not been approved" };
}
