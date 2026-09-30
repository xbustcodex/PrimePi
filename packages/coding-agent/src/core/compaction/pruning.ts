/**
 * Per-turn tool-result pruning: the point where the projected session history is
 * rewritten so stale and uninformative tool results stop occupying the prompt.
 *
 * ## Why this lives here and not in the pruner
 *
 * `pruneToolOutputs` (in `@earendil-works/pi-agent-core`) is pure: it takes a
 * message array and returns a new one. What it cannot know is *which session
 * entry* each message came from, or how a rewrite is persisted. In this codebase
 * the only authority for changing what a stored entry contributes to the model
 * is `SessionManager.appendContextEdit`, which appends a `context_edit` entry
 * targeting an earlier one. So the prune result is turned into a list of
 * `context_edit` drafts, and the session owns the write.
 *
 * That also preserves the journal: the raw tool result stays on disk, and the
 * notice is provenance-tracked as an edit rather than a silent mutation. The
 * same mechanism `_omitRecoveryAttempt` uses to drop a failed attempt.
 *
 * ## Why it runs before compaction decides anything
 *
 * Two different things are being reclaimed. Age-based pruning (large but merely
 * old output) belongs to compaction: it costs an LLM call and rebuilds the
 * prompt cache anyway, so it is willing to pay. Superseding and uninformative
 * results are free and are never worth an LLM call, so they are reclaimed as
 * soon as a newer read proves them redundant. Both are decided from the same
 * projection compaction reads, so pruning first means compaction summarizes
 * from history that is already smaller.
 *
 * ## What must never be dropped
 *
 * - The newest read of a target is never a supersede candidate, so a re-read
 *   never removes the only copy of a file.
 * - A read whose *result* declares an internal `artifact://` source is
 *   protected: eliding it mints a replacement read, and the loop is bounded
 *   only by the context window.
 * - A failed call is never uninformative. "Command not found" is the most
 *   informative thing a failed call can say.
 * - An entry that already carries a `context_edit` is skipped, so repeated
 *   turns do not stack duplicate edits.
 * - The most recent `protectTokens` of output is left intact, and a result
 *   sitting in the provider's warm cache prefix is left to compaction, which
 *   rewrites the cache regardless.
 */

import {
	DEFAULT_PRUNE_CONFIG,
	isArtifactRecoveryResult,
	type PruneConfig,
	pruneToolOutputs,
} from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { buildContextEntries, buildSessionProjection, type SessionEntry } from "../session-manager.ts";

/**
 * Results whose all-message suffix exceeds this sit in the provider's warm
 * cache prefix. Rewriting one re-writes the whole suffix at the cache-write
 * price, which can cost more than the pruning saves, so they are left to
 * compaction.
 */
const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/** The two compaction settings that select which rules apply. */
export interface ToolResultPruneSettings {
	/** Replace a read result that a newer read of the same target replaced. */
	readonly supersedeReads: boolean;
	/** Replace a result that carries no information with a short notice. */
	readonly dropUseless: boolean;
}

/** One persisted rewrite: the entry to edit and the notice that replaces it. */
export interface ToolResultPruneEdit {
	readonly targetId: string;
	readonly notice: string;
}

export interface StaleToolResultPrunePlan {
	readonly edits: readonly ToolResultPruneEdit[];
	readonly tokensSaved: number;
}

/**
 * The supersede key for a `read` call.
 *
 * A plain read of a path keys on the path. A ranged read (offset/limit) keys on
 * the path plus its range, which the `SupersedeKeyFn` contract treats as
 * `path + "\0" + selector`: a later whole-file read of the same path therefore
 * supersedes every earlier partial read of it, because the whole-file read is
 * strictly newer information. The reverse never holds — a partial read never
 * supersedes a whole-file read.
 *
 * Non-`read` tools and unreadable paths are exempt: grouping two unrelated
 * calls under a shared key would drop a result nothing had superseded.
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	// A URL-shaped path is a virtual source (skill://, artifact://), not a file.
	// Those are protected by rule, and keying them here would only make the
	// protection unreachable.
	if (path.includes("://")) return undefined;
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return path;
	return `${path}\0${offset ?? ""}:${limit ?? ""}`;
}

/**
 * The prune rules selected by the two settings, over the shared defaults.
 *
 * Two defaults are deliberately not inherited:
 *
 * `minimumSavings` is a *compaction-time* budget — 20 000 tokens is a sensible
 * "is this compaction worth an LLM call" floor, and it is why age-based
 * pruning does not fire on every turn. A superseded read is already known to be
 * dead weight, so waiting to accumulate 20 000 tokens of savings means the
 * stale result stays in the prompt for many turns after it stopped mattering.
 * The cost this floor was protecting against — churning the prompt cache for
 * almost nothing — is already covered by `cacheWarmSuffixTokens`, which refuses
 * any rewrite inside the warm prefix.
 *
 * `protectTokens` is kept at its default: the most recent output stays intact,
 * because a model mid-investigation needs what it just fetched. Superseded and
 * uninformative results bypass that window by design, which is correct here —
 * they are dead at any age.
 */
function buildPruneConfig(settings: ToolResultPruneSettings): PruneConfig {
	return {
		...DEFAULT_PRUNE_CONFIG,
		protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools, isArtifactRecoveryResult],
		supersedeKey: settings.supersedeReads ? readToolSupersedeKey : undefined,
		pruneUseless: settings.dropUseless,
		minimumSavings: 0,
		cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
	};
}

/**
 * Plan the `context_edit` entries that carry a prune into persisted history.
 *
 * Pure: it reads the session and returns drafts. Nothing is written, and the
 * input is never mutated. The caller appends the edits, so the session stays
 * the single writer of its own history.
 */
export function planStaleToolResultPrunes(
	entries: SessionEntry[],
	leafId: string | null,
	settings: ToolResultPruneSettings,
): StaleToolResultPrunePlan {
	// Both rules off means there is nothing to plan. Checked before any
	// projection work so a fully-disabled pass costs nothing.
	if (!settings.supersedeReads && !settings.dropUseless) return { edits: [], tokensSaved: 0 };

	const projection = buildSessionProjection(entries, leafId);
	// An entry that already has a context edit is not re-edited: a second pass
	// would see the same notice text through the same tool call and stack an
	// identical edit on every turn.
	const edited = new Set<string>();
	for (const entry of buildContextEntries(entries, leafId)) {
		if (entry.type === "context_edit") edited.add(entry.targetId);
	}
	if (edited.size === projection.messages.length) return { edits: [], tokensSaved: 0 };

	// The projection is typed as `AgentMessage[]`, a superset of pi-ai's
	// `Message` that adds session-only roles (bashExecution, custom,
	// branchSummary, compactionSummary). The pruner reads only `role`,
	// `content` and `timestamp`, all of which those roles also carry, and it
	// ignores every role it does not recognise. Widening the element type here
	// keeps the array index-aligned with `projection.entries`, which is what
	// lets a rewritten message be traced back to a stored entry.
	const result = pruneToolOutputs(projection.messages as readonly Message[], buildPruneConfig(settings));
	if (result.prunedCount === 0) return { edits: [], tokensSaved: 0 };

	// Map each projected message back to the session entry it came from, so a
	// rewritten result can be attributed to a stored entry rather than to a
	// position in an array.
	const entryIdByIndex: (string | undefined)[] = [];
	for (const projected of projection.entries) {
		for (let offset = 0; offset < projected.messages.length; offset++) {
			entryIdByIndex.push(projected.sourceEntry.id);
		}
	}

	const edits: ToolResultPruneEdit[] = [];
	for (let index = 0; index < result.messages.length; index++) {
		const message = result.messages[index];
		if (message === projection.messages[index]) continue;
		const targetId = entryIdByIndex[index];
		if (targetId === undefined || edited.has(targetId)) continue;
		edits.push({ targetId, notice: contentText((message as { content: unknown }).content as never) });
	}
	if (edits.length === 0) return { edits: [], tokensSaved: 0 };
	return { edits, tokensSaved: result.tokensSaved };
}
