/**
 * Grep context windows: how much surrounding text a match carries, and how the
 * budget is spent.
 *
 * ## The budget is consumed once, not per match
 *
 * Two matches three lines apart share the context between them. Emitting that
 * context twice is how a search for one symbol produces a thousand lines of
 * output, most of it duplicated, and the duplication is what makes a result
 * *look* larger than it is.
 *
 * So context regions are **merged** before they are cut: overlapping or adjacent
 * regions become one, and the merged region is bounded once.
 *
 * ## Overlapping matches do not duplicate their context
 *
 * The same rule at match level. Two matches inside one another's context window
 * are one *region*, and the output says so, so a reader can tell a dense cluster
 * from a wide one.
 *
 * ## The precedence rule for overrides
 *
 * A protocol bridge that carries an explicit context width **overrides** the
 * session setting, because the bridge's caller has a contract the session does
 * not. A total match cap applies **on top of** the built-in per-file and
 * file-window caps, **never above** them — a bridge asking for more matches than
 * the tool would allow is asking for a different tool.
 *
 * The model-facing schema does not grow these knobs. Unset means "use the
 * session settings and the built-in caps", which is the behaviour every
 * model-issued call keeps.
 */

/** A half-open line range, inclusive of both ends. */
export interface LineRange {
	readonly start: number;
	readonly end: number;
}

/** A match with its line number. */
export interface GrepMatch {
	readonly line: number;
	readonly text: string;
}

export interface GrepContextOptions {
	/** Lines of context before each match. */
	readonly before: number;
	/** Lines of context after each match. */
	readonly after: number;
	/** The file's line count, for clamping at the boundaries. */
	readonly fileLines: number;
	/** Overrides both `before` and `after` for this call, when the protocol carries one. */
	readonly contextOverride?: number;
}

/** Whether an override is present, and what it normalises to. */
function effectiveContext(options: GrepContextOptions): { before: number; after: number; overridden: boolean } {
	if (options.contextOverride !== undefined) {
		// The bridge's caller holds a contract the session does not, so its width
		// replaces both directions rather than only widening one.
		const width = Math.max(0, Math.floor(options.contextOverride));
		return { before: width, after: width, overridden: true };
	}
	return {
		before: Math.max(0, Math.floor(options.before)),
		after: Math.max(0, Math.floor(options.after)),
		overridden: false,
	};
}

/** The context region around a match, clamped to the file. */
function regionFor(line: number, before: number, after: number, fileLines: number): LineRange {
	return {
		start: Math.max(0, line - before),
		// A match on the last line must not ask for lines past the end; the output
		// would then claim context the file does not have.
		end: Math.min(Math.max(0, fileLines - 1), line + after),
	};
}

/**
 * Merges match context regions.
 *
 * Overlapping or adjacent regions become one, so a dense cluster of matches is
 * one contiguous block rather than the same lines repeated.
 */
export function mergeContextRegions(matches: readonly GrepMatch[], options: GrepContextOptions): LineRange[] {
	const { before, after } = effectiveContext(options);
	if (before === 0 && after === 0) {
		// No context means each match is its own region, and merging them would
		// silently include lines the caller did not ask for.
		return matches.map((match) => ({ start: match.line, end: match.line }));
	}
	const sorted = [...matches].sort((left, right) => left.line - right.line);
	const merged: LineRange[] = [];
	for (const match of sorted) {
		const region = regionFor(match.line, before, after, options.fileLines);
		const last = merged.at(-1);
		// Adjacent counts as overlapping: two regions separated by one line would
		// otherwise emit that line twice.
		if (last && region.start <= last.end + 1) {
			merged[merged.length - 1] = { start: Math.min(last.start, region.start), end: Math.max(last.end, region.end) };
			continue;
		}
		merged.push(region);
	}
	return merged;
}

/** A region together with the matches inside it. */
export interface GrepOutputRegion extends LineRange {
	readonly matchLines: readonly number[];
}

/** The grouped, merged view of a file's matches. */
export function groupMatches(matches: readonly GrepMatch[], options: GrepContextOptions): GrepOutputRegion[] {
	const regions = mergeContextRegions(matches, options);
	const ordered = [...matches].sort((left, right) => left.line - right.line);
	return regions.map((region) => ({
		...region,
		// Only the matches inside this region, so a reader can tell a dense cluster
		// from a wide one instead of seeing one line per match repeated.
		matchLines: ordered
			.filter((match) => match.line >= region.start && match.line <= region.end)
			.map((match) => match.line),
	}));
}

/** How many lines a grouped view will print. */
export function contextLineCount(regions: readonly LineRange[]): number {
	return regions.reduce((total, region) => total + (region.end - region.start + 1), 0);
}

/** A file window cap, applied on top of and never above the built-in one. */
export function resolveMatchLimit(input: {
	requested?: number;
	builtInPerFile: number;
	builtInWindow: number;
}): number {
	const builtIn = Math.max(1, Math.min(input.builtInPerFile, input.builtInWindow));
	// A bridge asking for more matches than the tool would allow is asking for a
	// different tool, so the cap only ever lowers.
	if (input.requested === undefined) return builtIn;
	return Math.max(1, Math.min(Math.trunc(input.requested), builtIn));
}

/** The built-in caps, which a caller's cap can lower but not raise. */
export const GREP_BUILTIN_LIMITS = {
	/** Matches surfaced per file. */
	perFile: 100,
	/** Matches surfaced across the whole search. */
	window: 500,
} as const;
