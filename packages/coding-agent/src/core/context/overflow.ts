/**
 * Context overflow: promote, defer, or compact — and in that order.
 *
 * ## The precedence, and why it is in that order
 *
 * When a session is about to overflow, three things are possible, and the order
 * matters more than any one of them.
 *
 * 1. **Defer to a speculative compaction** that is already running. Compacting
 *    twice in a row discards history the first pass was still summarising, so a
 *    maintenance pass already in flight is waited for rather than duplicated.
 * 2. **Promote to a larger-context model.** Switching models avoids compacting
 *    the history *at all*. That is strictly better than summarising: the history
 *    stays whole and the model still sees all of it.
 * 3. **Compact.** Only when there is nothing to defer to and nothing to promote
 *    to.
 *
 * The order is the reference's, and the reason is in its comment: without the
 * promotion step, the pre-prompt path would pre-empt promotion and compact a
 * session that should have just been promoted. That is the failure this
 * ordering exists to prevent.
 *
 * ## Promotion is not always possible
 *
 * A promotion needs a **larger-context model that is actually configured and
 * usable**. If there is none — every larger model is disabled, uncredentialed, or
 * absent from the registry — the promotion is skipped and compaction runs, rather
 * than the session failing.
 *
 * ## Workspace roots, and why they are resolved once
 *
 * Additional workspace directories are resolved against the working directory at
 * the moment they are added, and stored resolved. Resolving at read time means
 * a session that changes directory silently re-points a root the user added
 * against a different tree.
 *
 * A root already inside another root is dropped rather than nested: listing both
 * produces duplicate search results and double-counts a file's path in every
 * relative reference.
 */

import path from "node:path";

/** A configured workspace root. */
export interface WorkspaceRoot {
	/** The absolute, resolved path. */
	readonly path: string;
	/** Where it came from, for a status line. */
	readonly source: "cwd" | "configured" | "command";
}

/** What to do about an approaching overflow. */
export type OverflowAction =
	| { readonly action: "defer"; readonly reason: string }
	| { readonly action: "promote"; readonly model: string; readonly reason: string }
	| { readonly action: "compact"; readonly reason: string }
	| { readonly action: "none"; readonly reason: string };

export interface OverflowInput {
	/** Tokens the next request would carry. */
	readonly pendingTokens: number;
	/** The active model's context window. */
	readonly contextWindow: number;
	/** A speculative maintenance pass is already running. */
	readonly speculativeCompactionRunning: boolean;
	/** Auto-promote is enabled. */
	readonly promotionEnabled: boolean;
	/** A larger-context model that is configured and usable, when there is one. */
	readonly largerModel?: { readonly id: string; readonly contextWindow: number };
}

/**
 * Decides what to do about an approaching overflow.
 *
 * The three-way order — defer, promote, compact — is the whole rule, and each
 * step exists because the one after it is worse.
 */
export function decideOverflow(input: OverflowInput): OverflowAction {
	// A maintenance pass already in flight is waited for. Compacting again would
	// discard history the first pass is still summarising.
	if (input.speculativeCompactionRunning) {
		return { action: "defer", reason: "a speculative compaction is already running" };
	}

	// Promotion avoids compacting the history at all, which is strictly better
	// than summarising it: the history stays whole.
	if (input.promotionEnabled && input.largerModel) {
		const fits = input.pendingTokens <= input.largerModel.contextWindow;
		if (fits) {
			return {
				action: "promote",
				model: input.largerModel.id,
				reason: `promoting avoids compacting ${input.pendingTokens} tokens of history`,
			};
		}
		// A larger model that still cannot hold it is not a promotion; compacting
		// is the only thing left.
	}

	// Compaction is last because it is the only option that loses information.
	return { action: "compact", reason: "nothing to defer to and nothing to promote to" };
}

/** Whether a promotion would avoid a compaction. */
export function promotionAvoidsCompaction(input: {
	readonly pendingTokens: number;
	readonly fromWindow: number;
	readonly toWindow: number;
}): boolean {
	// Both conditions: the current model is actually full, and the candidate
	// actually fits. A "larger" model that still overflows is not an escape.
	return input.pendingTokens >= input.fromWindow && input.pendingTokens <= input.toWindow;
}

/** The roots a session is scoped to. */
export function buildWorkspaceRoots(input: {
	readonly cwd: string;
	/** Configured paths, relative or absolute. */
	readonly additionalDirectories: readonly string[];
}): WorkspaceRoot[] {
	const base = path.resolve(input.cwd);
	const roots: WorkspaceRoot[] = [{ path: base, source: "cwd" }];

	// Resolved once, at the moment they are added. Resolving at read time means a
	// session that changes directory re-points a root against a different tree.
	for (const configured of input.additionalDirectories) {
		const trimmed = configured.trim();
		if (trimmed.length === 0) continue;
		// Relative paths resolve against the working directory, as the reference
		// documents; absolute ones are taken as given.
		const resolved = path.resolve(base, trimmed);
		// A root already inside another is dropped rather than nested: listing both
		// duplicates search results and double-counts a path in every relative
		// reference.
		if (roots.some((root) => isInside(resolved, root.path) || isInside(root.path, resolved))) continue;
		roots.push({ path: resolved, source: "configured" });
	}
	return roots;
}

/** Whether `child` is inside `parent`, or equal to it. */
export function isInside(child: string, parent: string): boolean {
	const normalise = (value: string) =>
		path
			.resolve(value)
			.replace(/[\\/]+$/, "")
			.toLowerCase();
	const from = normalise(child);
	const to = normalise(parent);
	if (from === to) return true;
	return from.startsWith(`${to}${path.sep}`) || from.startsWith(`${to}/`);
}

/** A path relative to whichever root contains it, prefixed with the root's name. */
export function relativeToRoot(roots: readonly WorkspaceRoot[], target: string): string | undefined {
	for (const root of roots) {
		if (!isInside(target, root.path)) continue;
		const relative = path.relative(root.path, target);
		// Prefixed so two roots containing the same relative path stay distinct in a
		// transcript.
		return `${path.basename(root.path)}/${relative}`.replace(/\\/g, "/");
	}
	return undefined;
}
