/**
 * Transcript display: what the user sees, and what a toggle actually changes.
 *
 * ## Cache-miss marker
 *
 * A request that **lost** the prompt cache re-reads the whole prefix, which is
 * slow and costs more. A divider after such a turn says *here is where the cache
 * was lost*, so the cause of a slow request is visible in the transcript rather
 * than inferred from timing.
 *
 * The rule is narrow on purpose: a turn that **wrote** the cache is not a miss,
 * and a turn with no cache at all is not a miss either. Marking those would put
 * a divider after every ordinary turn and make the marker noise.
 *
 * ## Collapse compacted history
 *
 * A compaction summarises everything before it. On the live transcript, keeping
 * that history inline means scrolling past messages the model no longer has -
 * which reads as "the agent forgot" when in fact it is a deliberate summary.
 *
 * Collapsed, the history sits behind one divider at the summary. Expanded, the
 * full transcript shows with a divider at **each** compaction point, which is
 * what someone debugging a summary needs.
 *
 * ## Token usage and turn time
 *
 * Both ride on the same usage row an assistant message already renders, so they
 * are display preferences rather than accounting: turning them off changes what
 * is drawn and nothing about what was spent. The usage *data* is recorded
 * either way.
 */

/** A cache outcome for one assistant turn. */
export type CacheOutcome = "hit" | "miss" | "write" | "none";

/** What usage a turn reported. */
export interface TurnUsage {
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/** Whether a turn lost the prompt cache. */
export function isCacheMiss(usage: TurnUsage, outcome: CacheOutcome): boolean {
	// Only an explicit miss, and only when something was actually cached before.
	// A turn with no cache at all has nothing to have missed, and a write is the
	// cache being created rather than lost.
	if (outcome !== "miss") return false;
	return usage.cacheReadTokens === 0 && (usage.cacheWriteTokens > 0 || usage.inputTokens > 0);
}

/** A usage row, as the transcript draws it. */
export interface UsageRow {
	readonly label: string;
	readonly value: string;
	/** True when the row is informational and a reader would want it. */
	readonly important: boolean;
}

/** Renders the usage rows a turn's preferences ask for. */
export function renderUsage(input: {
	readonly usage: TurnUsage;
	readonly cacheMiss: boolean;
	readonly showTokenUsage: boolean;
	readonly showTurnTime: boolean;
	readonly turnMs?: number;
}): UsageRow[] {
	const rows: UsageRow[] = [];
	if (input.showTokenUsage) {
		const total = input.usage.inputTokens + input.usage.outputTokens + input.usage.cacheReadTokens;
		rows.push({ label: "tokens", value: String(total), important: false });
		if (input.usage.cacheReadTokens > 0) {
			rows.push({ label: "cached", value: String(input.usage.cacheReadTokens), important: false });
		}
	}
	if (input.showTurnTime && input.turnMs !== undefined) {
		rows.push({ label: "took", value: `${(input.turnMs / 1000).toFixed(1)}s`, important: false });
	}
	// A cache miss rides with the usage row rather than being a separate divider,
	// because the cost is in the usage and the marker explains it.
	if (input.cacheMiss) {
		rows.push({ label: "cache", value: "missed", important: true });
	}
	return rows;
}

/** Where compaction points fall in a transcript. */
export interface CompactionPoint {
	/** The entry id of the compaction summary. */
	readonly id: string;
	/** Entries before this point were summarized away. */
	readonly summarizesFromIndex: number;
	/** How many entries were summarized. */
	readonly summarizedCount: number;
}

/** One section of the rendered transcript. */
export interface TranscriptSection {
	/** Live, un-summarized entries. */
	readonly visible: readonly number[];
	/** Indices hidden behind a compaction summary, oldest first. */
	readonly collapsed: readonly number[];
	/** One divider per compaction point that has content behind it. */
	readonly dividers: readonly { readonly atIndex: number; readonly summarizedCount: number }[];
}

/**
 * Splits a transcript into visible and collapsed sections.
 *
 * With `collapse` on, everything before the *latest* compaction is behind one
 * divider, because a second divider for a region the reader already cannot see
 * is a divider that leads nowhere.
 *
 * With `collapse` off, a divider appears at **each** compaction point, which is
 * what someone reading the history of a conversation needs.
 */
export function layoutCompacted(
	entryCount: number,
	points: readonly CompactionPoint[],
	collapse: boolean,
): TranscriptSection {
	if (entryCount <= 0) return { visible: [], collapsed: [], dividers: [] };
	if (points.length === 0) return { visible: range(entryCount), collapsed: [], dividers: [] };

	const ordered = [...points].sort((left, right) => right.summarizesFromIndex - left.summarizesFromIndex);

	if (collapse) {
		// The latest compaction hides the most, so the collapsed region is the
		// union of everything every point summarized.
		const boundary = Math.max(...ordered.map((point) => point.summarizesFromIndex));
		const collapsed = boundary > 0 ? range(boundary) : [];
		const total = points.reduce((sum, point) => sum + point.summarizedCount, 0);
		return {
			visible: collapsed.length > 0 ? range(entryCount - collapsed.length) : range(entryCount),
			collapsed,
			dividers: collapsed.length > 0 ? [{ atIndex: boundary, summarizedCount: total }] : [],
		};
	}

	// Expanded: a divider at every point, each covering only the region it
	// summarized, so the reader can see where each summary came from.
	const collapsedSet = new Set<number>();
	const dividers: { atIndex: number; summarizedCount: number }[] = [];
	for (const point of ordered) {
		for (let index = 0; index < point.summarizesFromIndex; index++) collapsedSet.add(index);
		dividers.push({ atIndex: point.summarizesFromIndex, summarizedCount: point.summarizedCount });
	}
	return {
		visible: range(entryCount).filter((index) => !collapsedSet.has(index)),
		collapsed: [...collapsedSet].sort((left, right) => left - right),
		dividers: dividers.sort((left, right) => left.atIndex - right.atIndex),
	};
}

function range(count: number): number[] {
	return Array.from({ length: Math.max(0, count) }, (_, index) => index);
}

/** How tool activity is shown. */
export type ToolActivityMode = "full" | "summary" | "hidden";

/**
 * Chooses how much tool activity a turn shows.
 *
 * "Hidden" is a display preference and does not stop a tool running or its
 * result being recorded: a reader who turns it off is choosing a shorter
 * transcript, not a session that forgot what it did.
 */
export function toolActivityMode(preference: "full" | "summary" | "hidden", entryCount: number): ToolActivityMode {
	if (preference === "hidden") return "hidden";
	// A long turn collapses to a summary on its own, so the setting is a floor
	// rather than the only mechanism.
	if (preference === "summary" || entryCount > 20) return "summary";
	return "full";
}
