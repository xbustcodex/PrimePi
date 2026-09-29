/**
 * Structural search: bounded result retention and paging.
 *
 * ## This layer holds no parser
 *
 * The matching engine is a native binding that Pi does not depend on. What
 * lives here is the part that is pure logic and the part that is easy to get
 * silently wrong: keeping the *right* matches when there are too many to hold,
 * and slicing a page out of an unbounded result.
 *
 * ## Retention is bounded, and the bound is load-bearing
 *
 * A structural search can return orders of magnitude more matches than a caller
 * asked for. Buffering all of them to sort at the end is what turns a fast
 * search into an out-of-memory kill, so matches are retained in a fixed-capacity
 * buffer holding the best `skip + limit + 1` seen so far.
 *
 * The `+ 1` is the whole trick. It is one more than the page needs, and its only
 * job is to let the caller distinguish "the result set ended exactly here" from
 * "there are more" — without it, a result set whose size is a multiple of the
 * page size reports `limitReached: false` on its last page and the caller stops
 * paging while matches remain.
 *
 * ## The order is total
 *
 * Two matches can share a path and a start position — nested patterns, or the
 * same construct reached by two patterns. The comparison therefore falls
 * through to the end position and finally the byte range, so it is a strict
 * weak ordering with no ties. A comparator with ties would make the retained
 * set depend on arrival order, and the same search would page differently on
 * two runs.
 *
 * ## Multi-target searches are paged after merging, not per target
 *
 * Paging each target separately and concatenating gives every early target a
 * full page and starves the last. Instead each target is asked for
 * `skip + limit + 1` and the retained buffers are merged and sorted once, so
 * paging is over the union.
 */

/** One structural match. */
export interface StructuralMatch {
	readonly path: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly byteStart: number;
	readonly byteEnd: number;
	/** Pattern that produced this match, when more than one was supplied. */
	readonly pattern?: string;
	/** Bindings captured for the pattern's metavariables. */
	readonly meta?: Readonly<Record<string, string>>;
}

/** What one target's engine returned. */
export interface TargetResult {
	readonly matches: readonly StructuralMatch[];
	/** Total found before paging, which may exceed `matches.length`. */
	readonly totalMatches: number;
	readonly filesWithMatches: number;
	readonly filesSearched: number;
	/** True when the engine itself truncated its own output. */
	readonly limitReached: boolean;
	readonly parseErrors?: readonly string[];
}

/** A page of merged, sorted matches. */
export interface StructuralPage {
	readonly matches: readonly StructuralMatch[];
	readonly totalMatches: number;
	readonly filesWithMatches: number;
	readonly filesSearched: number;
	readonly limitReached: boolean;
	readonly parseErrors?: readonly string[];
}

/**
 * Total order over matches.
 *
 * Falls through to the byte range so two structurally distinct matches never
 * compare equal. With ties, the retained set would depend on arrival order and
 * the same search would page differently between runs.
 */
export function compareMatches(left: StructuralMatch, right: StructuralMatch): number {
	if (left.path !== right.path) return left.path < right.path ? -1 : 1;
	if (left.startLine !== right.startLine) return left.startLine - right.startLine;
	if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
	if (left.endLine !== right.endLine) return left.endLine - right.endLine;
	if (left.endColumn !== right.endColumn) return left.endColumn - right.endColumn;
	if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
	return left.byteEnd - right.byteEnd;
}

/**
 * A fixed-capacity buffer holding the best matches seen so far.
 *
 * Insertion is O(capacity) once full, which is the deliberate trade: a heap
 * would be O(log n) but cannot hand back a sorted page without a second pass,
 * and the capacity is `skip + limit + 1` — a page, not a result set.
 */
export class MatchRetainer {
	readonly #matches: StructuralMatch[] = [];
	readonly #capacity: number;

	constructor(capacity: number) {
		this.#capacity = Math.max(0, Math.trunc(capacity));
	}

	get size(): number {
		return this.#matches.length;
	}

	add(candidate: StructuralMatch): void {
		if (this.#capacity === 0) return;
		if (this.#matches.length < this.#capacity) {
			this.#matches.push(candidate);
			return;
		}
		// Replace the worst only if the candidate beats it, so a full buffer never
		// degrades: an equal-or-worse match is discarded rather than churning the
		// array into a different order.
		let worstIndex = 0;
		for (let index = 1; index < this.#matches.length; index++) {
			if (compareMatches(this.#matches[index]!, this.#matches[worstIndex]!) > 0) worstIndex = index;
		}
		if (compareMatches(candidate, this.#matches[worstIndex]!) < 0) this.#matches[worstIndex] = candidate;
	}

	/** The retained matches, sorted. */
	sorted(): StructuralMatch[] {
		return [...this.#matches].sort(compareMatches);
	}
}

/** Whether a page is the last one. */
export function isLastPage(page: StructuralPage): boolean {
	return !page.limitReached;
}

/**
 * Merges per-target results into one page.
 *
 * The engine is asked for `skip + limit + 1` per target. That over-fetch is
 * what makes the merged page correct when matches are spread unevenly: a target
 * contributing a single match must not be able to starve a later one, and a
 * per-target page would do exactly that.
 */
export function mergeStructuralResults(input: {
	readonly results: readonly TargetResult[];
	readonly skip: number;
	readonly limit: number;
	/** Rewrites a target-relative path to the caller's base. */
	readonly rebase?: (path: string, result: TargetResult) => string;
}): StructuralPage {
	const skip = Math.max(0, Math.trunc(input.skip));
	const limit = Math.max(0, Math.trunc(input.limit));
	// One more than the page needs, so a result set that is an exact multiple of
	// the page size still reports that more remain.
	const capacity = skip + limit + 1;
	const retainer = new MatchRetainer(capacity);

	let totalMatches = 0;
	let filesWithMatches = 0;
	let filesSearched = 0;
	let engineTruncated = false;
	const parseErrors: string[] = [];

	for (const result of input.results) {
		totalMatches += result.totalMatches;
		filesWithMatches += result.filesWithMatches;
		filesSearched += result.filesSearched;
		engineTruncated ||= result.limitReached;
		if (result.parseErrors) parseErrors.push(...result.parseErrors);
		for (const match of result.matches) {
			const path = input.rebase ? input.rebase(match.path, result) : match.path;
			retainer.add(path === match.path ? match : { ...match, path });
		}
	}

	const sorted = retainer.sorted();
	const visible = sorted.slice(skip);
	return {
		matches: visible.slice(0, limit),
		totalMatches,
		filesWithMatches,
		filesSearched,
		limitReached: engineTruncated || visible.length > limit,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

/** How many matches to request from one target so the merged page is correct. */
export function perTargetFetch(skip: number, limit: number): number {
	return Math.max(0, Math.trunc(skip)) + Math.max(0, Math.trunc(limit)) + 1;
}
