/**
 * Hindsight bank scoping: which memories a project can reach.
 *
 * ## Three modes, and what each guarantees
 *
 * - **global** — one shared bank, no project filter. Everything is reachable
 *   from everywhere, which is the point and also the hazard.
 * - **per-project** — one bank per project, **hard isolation**. A memory
 *   written under one project is not merely filtered out of another's recall; it
 *   is in a different bank entirely. That is a stronger guarantee than tagging
 *   and survives a bug in the filter.
 * - **per-project-tagged** — one shared bank, retains carry a `project:<name>`
 *   tag, and recall filters on it.
 *
 * ## Why tagged mode still surfaces untagged memories
 *
 * The recall tag filter defaults to **matching any**, not all. That is
 * deliberate: a memory written before tagging existed has no tag, and an `all`
 * filter would hide every pre-existing memory from a project that had been
 * using the service untagged. Silently losing them is worse than occasionally
 * surfacing a global memory in a project view.
 *
 * A user who wants strict isolation configures `per-project`, where the
 * guarantee does not depend on filter behaviour at all.
 */

/** How projects are separated. */
export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

/** How the recall tag filter combines tags. */
export type RecallTagsMatch = "any" | "all";

export interface HindsightConfig {
	/** Bank id prefix, defaulting to `omp`. */
	readonly bankIdPrefix: string;
	/** Optional bank id set explicitly. */
	readonly bankId?: string;
	readonly scoping: HindsightScoping;
	/** The project identity, used for per-project modes. */
	readonly project: string;
}

/** Where a retain lands and what recall will look for. */
export interface BankScope {
	/** The bank the operations use. */
	readonly bankId: string;
	/** Tags applied to every retain. Absent when scoping does not tag. */
	readonly retainTags?: readonly string[];
	/** Tags recall filters on. Absent when scoping does not tag. */
	readonly recallTags?: readonly string[];
	/** How the filter combines. Defaults to `any` so untagged memories surface. */
	readonly recallTagsMatch?: RecallTagsMatch;
	readonly reason: string;
}

/** The bank id before any project segment. */
function baseBankId(config: HindsightConfig): string {
	const explicit = config.bankId?.trim();
	if (explicit) return explicit;
	const prefix = config.bankIdPrefix.trim() || "omp";
	return prefix;
}

/**
 * Resolves the bank and tags for a project.
 *
 * The `any` default is the part that is easy to get wrong, so it is stated
 * here as well as in the return value.
 */
export function resolveBankScope(config: HindsightConfig): BankScope {
	const base = baseBankId(config);
	const projectTag = `project:${config.project}`;

	switch (config.scoping) {
		case "global":
			return {
				bankId: base,
				reason: "one shared bank, so nothing is filtered by project",
			};
		case "per-project":
			// The project segment is part of the *bank name*, not a tag. Isolation
			// therefore does not depend on the recall filter behaving correctly.
			return {
				bankId: `${base}-${config.project}`,
				reason: "a separate bank per project, so isolation does not rely on a filter",
			};
		case "per-project-tagged":
			return {
				bankId: base,
				retainTags: [projectTag],
				recallTags: [projectTag],
				// `any`, not `all`: a memory written before tagging existed has no tag,
				// and an `all` filter would hide every one of them from a project that
				// had been using the service untagged.
				recallTagsMatch: "any",
				reason: "one shared bank filtered by a project tag, with untagged memories still surfacing",
			};
	}
}

/** Whether two projects can see each other's memories. */
export function isolationBetween(left: HindsightConfig, right: HindsightConfig): "none" | "tagged" | "hard" {
	if (left.scoping === "global" || right.scoping === "global") return "none";
	if (left.scoping === "per-project" && right.scoping === "per-project") return "hard";
	return "tagged";
}

/** One line for a settings hint. */
export function describeScoping(scoping: HindsightScoping): string {
	switch (scoping) {
		case "global":
			return "One shared bank. Every project sees every memory, including the ones it did not write.";
		case "per-project":
			return "A bank per project. Memories are isolated by bank, not by a recall filter.";
		case "per-project-tagged":
			return "One shared bank, filtered by a project tag. Untagged memories still surface.";
	}
}

/**
 * Whether a recalled memory may be used under a scope.
 *
 * Kept separate from the filter a service applies, so a caller can tell a
 * memory the service returned from one that is actually in scope.
 */
export function isInScope(scope: BankScope, memory: { readonly tags?: readonly string[] }): boolean {
	// Hard isolation: the bank already decided, and a memory in another bank was
	// never returned.
	if (!scope.recallTags) return true;
	// An untagged memory is in scope under the default filter, because that is what
	// makes pre-tagging memories visible.
	if (!memory.tags || memory.tags.length === 0) return scope.recallTagsMatch !== "all";
	if (scope.recallTagsMatch === "all") {
		return scope.recallTags.every((tag) => memory.tags!.includes(tag));
	}
	return scope.recallTags.some((tag) => memory.tags!.includes(tag));
}
