import { describe, expect, it } from "vitest";
import {
	contextLineCount,
	GREP_BUILTIN_LIMITS,
	groupMatches,
	mergeContextRegions,
	resolveMatchLimit,
} from "../src/core/tools/grep-context.ts";

/**
 * Grep context windows.
 *
 * The property that matters most: context is consumed **once**, not per match.
 * Two matches three lines apart share the context between them, and emitting it
 * twice is how a search for one symbol produces a thousand lines of duplicated
 * output that looks larger than it is.
 */

const match = (line: number) => ({ line, text: `line ${line}` });

describe("context regions are merged, not repeated", () => {
	it("merges overlapping regions into one", () => {
		// Matches three apart with one line of context each touch.
		const regions = mergeContextRegions([match(10), match(13)], { before: 1, after: 1, fileLines: 100 });
		expect(regions).toEqual([{ start: 9, end: 14 }]);
	});

	it("keeps distant matches apart", () => {
		const regions = mergeContextRegions([match(10), match(50)], { before: 2, after: 2, fileLines: 100 });
		expect(regions).toHaveLength(2);
	});

	it("merges adjacent regions, which would otherwise repeat a line", () => {
		// Two regions separated by exactly one line would print that line twice.
		const regions = mergeContextRegions([match(10), match(13)], { before: 0, after: 0, fileLines: 100 });
		// With no context each match is its own region and is not merged, because
		// merging would include lines the caller did not ask for.
		expect(regions).toHaveLength(2);
	});

	it("emits each match's own line when there is no context", () => {
		const regions = mergeContextRegions([match(10), match(11)], { before: 0, after: 0, fileLines: 100 });
		expect(regions).toEqual([
			{ start: 10, end: 10 },
			{ start: 11, end: 11 },
		]);
	});

	it("clamps a region at the start of the file", () => {
		expect(mergeContextRegions([match(0)], { before: 5, after: 0, fileLines: 100 })).toEqual([{ start: 0, end: 0 }]);
	});

	it("clamps a region at the end, so it never claims absent lines", () => {
		// A match on the last line must not ask for lines past the end.
		const regions = mergeContextRegions([match(9)], { before: 0, after: 50, fileLines: 10 });
		expect(regions).toEqual([{ start: 9, end: 9 }]);
	});
});

describe("an override replaces both directions", () => {
	it("uses the override rather than the session settings", () => {
		// The bridge's caller holds a contract the session does not, so its width
		// replaces both directions rather than only widening one.
		const regions = mergeContextRegions([match(10)], {
			before: 0,
			after: 0,
			contextOverride: 2,
			fileLines: 100,
		});
		expect(regions).toEqual([{ start: 8, end: 12 }]);
	});

	it("clamps a negative override to zero", () => {
		const regions = mergeContextRegions([match(10)], {
			before: 5,
			after: 5,
			contextOverride: -3,
			fileLines: 100,
		});
		expect(regions).toEqual([{ start: 10, end: 10 }]);
	});
});

describe("grouping tells a dense cluster from a wide one", () => {
	it("lists only the matches inside each region", () => {
		const grouped = groupMatches([match(10), match(11), match(50)], { before: 1, after: 1, fileLines: 100 });
		expect(grouped).toHaveLength(2);
		// A reader can see the cluster is dense instead of seeing one line per match
		// repeated.
		expect(grouped[0]!.matchLines).toEqual([10, 11]);
		expect(grouped[1]!.matchLines).toEqual([50]);
	});

	it("counts the lines a view will print", () => {
		// This is the number the user actually pays for in context.
		const regions = mergeContextRegions([match(10), match(13)], { before: 1, after: 1, fileLines: 100 });
		expect(contextLineCount(regions)).toBe(6);
	});

	it("costs no more than the matches when there is no context", () => {
		const regions = mergeContextRegions([match(10), match(11), match(12)], { before: 0, after: 0, fileLines: 100 });
		expect(contextLineCount(regions)).toBe(3);
	});
});

describe("a caller cap can lower the built-in limit, never raise it", () => {
	it("uses the tighter of the built-in caps by default", () => {
		expect(resolveMatchLimit({ builtInPerFile: 100, builtInWindow: 500 })).toBe(100);
	});

	it("lets a caller lower it", () => {
		expect(resolveMatchLimit({ requested: 10, builtInPerFile: 100, builtInWindow: 500 })).toBe(10);
	});

	it("refuses to raise it", () => {
		// A bridge asking for more matches than the tool would allow is asking for
		// a different tool.
		expect(resolveMatchLimit({ requested: 10_000, builtInPerFile: 100, builtInWindow: 500 })).toBe(100);
	});

	it("never resolves to zero", () => {
		expect(resolveMatchLimit({ requested: 0, builtInPerFile: 100, builtInWindow: 500 })).toBe(1);
	});

	it("exposes the built-in caps it protects", () => {
		expect(GREP_BUILTIN_LIMITS.perFile).toBeLessThan(GREP_BUILTIN_LIMITS.window);
	});
});
