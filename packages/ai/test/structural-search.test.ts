import { describe, expect, it } from "vitest";
import {
	compareMatches,
	isLastPage,
	MatchRetainer,
	mergeStructuralResults,
	perTargetFetch,
	type StructuralMatch,
	type TargetResult,
} from "../src/utils/structural-search.ts";

/**
 * Structural search paging.
 *
 * The property that matters is **the last page is identified exactly**. A
 * result set whose size is a whole multiple of the page size is the case that
 * breaks naive implementations: without an over-fetch by one, the final page
 * reports "no more results" and the caller stops while matches remain.
 */

const match = (path: string, line: number, overrides: Partial<StructuralMatch> = {}): StructuralMatch => ({
	path,
	startLine: line,
	startColumn: 0,
	endLine: line,
	endColumn: 10,
	byteStart: line * 100,
	byteEnd: line * 100 + 10,
	...overrides,
});

const result = (matches: StructuralMatch[], overrides: Partial<TargetResult> = {}): TargetResult => ({
	matches,
	totalMatches: matches.length,
	filesWithMatches: new Set(matches.map((m) => m.path)).size,
	filesSearched: 1,
	limitReached: false,
	...overrides,
});

describe("the order is total", () => {
	it("orders by path, then position", () => {
		expect(compareMatches(match("a.ts", 1), match("b.ts", 1))).toBeLessThan(0);
		expect(compareMatches(match("a.ts", 2), match("a.ts", 1))).toBeGreaterThan(0);
	});

	it("separates two matches sharing a start position", () => {
		// Nested patterns reach the same start; without the fallthrough the retained
		// set would depend on arrival order.
		const outer = match("a.ts", 5, { endLine: 9 });
		const inner = match("a.ts", 5, { endLine: 6 });
		expect(compareMatches(outer, inner)).toBeGreaterThan(0);
		expect(compareMatches(inner, outer)).toBeLessThan(0);
	});

	it("never reports two distinct matches as equal", () => {
		expect(compareMatches(match("a.ts", 1, { endColumn: 20 }), match("a.ts", 1, { endColumn: 30 }))).toBeLessThan(0);
	});
});

describe("retention is bounded", () => {
	it("keeps the best matches, not the first ones", () => {
		const retainer = new MatchRetainer(2);
		for (const line of [5, 1, 3]) retainer.add(match("a.ts", line));
		// Line 5 arrived first and is discarded: order of arrival is not merit.
		expect(retainer.sorted().map((m) => m.startLine)).toEqual([1, 3]);
	});

	it("holds exactly its capacity", () => {
		const retainer = new MatchRetainer(3);
		for (let line = 0; line < 50; line++) retainer.add(match("a.ts", line));
		expect(retainer.size).toBe(3);
	});

	it("discards an equal-or-worse match rather than churning the buffer", () => {
		const retainer = new MatchRetainer(1);
		retainer.add(match("a.ts", 5));
		retainer.add(match("a.ts", 5));
		expect(retainer.size).toBe(1);
		expect(retainer.sorted()[0]?.startLine).toBe(5);
	});

	it("keeps nothing at zero capacity", () => {
		const retainer = new MatchRetainer(0);
		retainer.add(match("a.ts", 1));
		expect(retainer.sorted()).toEqual([]);
	});
});

describe("paging identifies the last page exactly", () => {
	it("reports more matches remain when a page is exactly full", () => {
		// The case a naive implementation gets wrong: four matches, two per page.
		const page = mergeStructuralResults({
			results: [result([match("a.ts", 1), match("a.ts", 2), match("a.ts", 3), match("a.ts", 4)])],
			skip: 0,
			limit: 2,
		});
		expect(page.matches).toHaveLength(2);
		expect(page.limitReached).toBe(true);
		expect(isLastPage(page)).toBe(false);
	});

	it("reports no more matches on the final page", () => {
		const page = mergeStructuralResults({
			results: [result([match("a.ts", 1), match("a.ts", 2), match("a.ts", 3), match("a.ts", 4)])],
			skip: 2,
			limit: 2,
		});
		expect(page.matches.map((m) => m.startLine)).toEqual([3, 4]);
		// Four matches, two per page: the second page is the last.
		expect(page.limitReached).toBe(false);
		expect(isLastPage(page)).toBe(true);
	});

	it("pages through everything without losing or repeating a match", () => {
		const all = Array.from({ length: 10 }, (_, index) => match("a.ts", index + 1));
		const seen: number[] = [];
		for (let skip = 0; ; skip += 3) {
			const page = mergeStructuralResults({ results: [result(all)], skip, limit: 3 });
			seen.push(...page.matches.map((m) => m.startLine));
			if (isLastPage(page)) break;
		}
		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("terminates on an exact multiple of the page size", () => {
		// The loop must not ask for a page past the end and spin.
		const all = Array.from({ length: 6 }, (_, index) => match("a.ts", index + 1));
		let pages = 0;
		for (let skip = 0; ; skip += 2) {
			pages++;
			const page = mergeStructuralResults({ results: [result(all)], skip, limit: 2 });
			if (isLastPage(page)) break;
			expect(pages).toBeLessThan(10);
		}
		expect(pages).toBe(3);
	});

	it("handles an empty result set", () => {
		const page = mergeStructuralResults({ results: [result([])], skip: 0, limit: 5 });
		expect(page.matches).toEqual([]);
		expect(isLastPage(page)).toBe(true);
	});
});

describe("multi-target results page after merging", () => {
	it("does not let an early target starve a later one", () => {
		// Paging each target separately would give the first target a full page and
		// leave the second invisible.
		const page = mergeStructuralResults({
			results: [result([match("a.ts", 1), match("a.ts", 2)]), result([match("z.ts", 99)])],
			skip: 0,
			limit: 3,
		});
		expect(page.matches.map((m) => m.path)).toEqual(["a.ts", "a.ts", "z.ts"]);
	});

	it("merges paths across targets into one order", () => {
		const page = mergeStructuralResults({
			results: [result([match("z.ts", 1)]), result([match("a.ts", 1)])],
			skip: 0,
			limit: 5,
		});
		expect(page.matches.map((m) => m.path)).toEqual(["a.ts", "z.ts"]);
	});

	it("rejects a page when the engine itself truncated", () => {
		// The engine reporting truncation is authoritative even if the merged buffer
		// looks complete.
		const page = mergeStructuralResults({
			results: [result([match("a.ts", 1)], { limitReached: true, totalMatches: 9_000 })],
			skip: 0,
			limit: 5,
		});
		expect(page.limitReached).toBe(true);
		expect(page.totalMatches).toBe(9_000);
	});

	it("sums totals across targets", () => {
		const page = mergeStructuralResults({
			results: [
				result([match("a.ts", 1)], { totalMatches: 5, filesSearched: 10 }),
				result([match("b.ts", 1)], { totalMatches: 7, filesSearched: 20 }),
			],
			skip: 0,
			limit: 5,
		});
		expect(page.totalMatches).toBe(12);
		expect(page.filesSearched).toBe(30);
		expect(page.filesWithMatches).toBe(2);
	});

	it("collects parse errors rather than dropping them", () => {
		// A file that failed to parse is a diagnostic the caller needs; losing it
		// makes a silently reduced result set look complete.
		const page = mergeStructuralResults({
			results: [result([match("a.ts", 1)], { parseErrors: ["a.ts: unexpected token"] }), result([match("b.ts", 1)])],
			skip: 0,
			limit: 5,
		});
		expect(page.parseErrors).toEqual(["a.ts: unexpected token"]);
	});

	it("omits parse errors entirely when there are none", () => {
		const page = mergeStructuralResults({ results: [result([match("a.ts", 1)])], skip: 0, limit: 5 });
		expect(page.parseErrors).toBeUndefined();
	});

	it("rebases a target-relative path onto the caller's base", () => {
		const page = mergeStructuralResults({
			results: [result([match("src/a.ts", 1)])],
			skip: 0,
			limit: 5,
			rebase: (path) => `C:/repo/${path}`,
		});
		expect(page.matches[0]?.path).toBe("C:/repo/src/a.ts");
	});
});

describe("the per-target fetch is one more than the page needs", () => {
	it("over-fetches by exactly one", () => {
		// That one extra is what lets a full final page report that more remain.
		expect(perTargetFetch(0, 10)).toBe(11);
		expect(perTargetFetch(5, 10)).toBe(16);
	});

	it("never asks for a negative number", () => {
		expect(perTargetFetch(-3, -4)).toBe(1);
	});
});
