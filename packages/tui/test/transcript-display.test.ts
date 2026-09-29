import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type CacheOutcome,
	type CompactionPoint,
	isCacheMiss,
	layoutCompacted,
	renderUsage,
	type TurnUsage,
	toolActivityMode,
} from "../src/transcript/display.ts";

/**
 * Transcript display.
 *
 * The properties that matter: a cache *write* is not a miss, and collapsing
 * compacted history puts **one** divider rather than one per compaction point -
 * a second divider for a region the reader already cannot see leads nowhere.
 */

const usage = (overrides: Partial<TurnUsage> = {}): TurnUsage => ({
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	inputTokens: 100,
	outputTokens: 50,
	...overrides,
});

describe("a cache miss is narrow on purpose", () => {
	it("marks a turn that lost the cache", () => {
		assert.equal(isCacheMiss(usage(), "miss"), true);
	});

	it("does not mark a turn that wrote the cache", () => {
		// A write is the cache being created, not lost.
		assert.equal(isCacheMiss(usage({ cacheWriteTokens: 500 }), "write"), false);
	});

	it("does not mark a turn that hit the cache", () => {
		assert.equal(isCacheMiss(usage({ cacheReadTokens: 5000 }), "hit"), false);
	});

	it("does not mark a turn with no cache at all", () => {
		// Nothing was cached before, so nothing was missed.
		assert.equal(isCacheMiss(usage({ inputTokens: 0, outputTokens: 0 }), "miss"), false);
	});

	it("ignores a miss label on a turn that did read cache", () => {
		assert.equal(isCacheMiss(usage({ cacheReadTokens: 10 }), "miss"), false);
	});
});

describe("usage rows are a display preference", () => {
	// turnMs is passed because showTurnTime alone has nothing to draw: the row is
	// only produced when the caller measured a duration.
	const base = { usage: usage(), cacheMiss: false, showTokenUsage: true, showTurnTime: true, turnMs: 1500 };

	it("draws the totals when asked", () => {
		const rows = renderUsage(base);
		assert.ok(rows.some((row) => row.label === "tokens" && row.value === "150"));
		assert.ok(rows.some((row) => row.label === "took" && row.value === "1.5s"));
	});

	it("draws nothing when both are off", () => {
		assert.equal(renderUsage({ ...base, showTokenUsage: false, showTurnTime: false }).length, 0);
	});

	it("reports cached tokens only when there are any", () => {
		assert.equal(
			renderUsage(base).some((row) => row.label === "cached"),
			false,
		);
		assert.ok(
			renderUsage({ ...base, usage: usage({ cacheReadTokens: 5000 }) }).some((row) => row.label === "cached"),
		);
	});

	it("marks a miss as important, because it explains the cost", () => {
		const rows = renderUsage({ ...base, cacheMiss: true });
		const miss = rows.find((row) => row.label === "cache");
		assert.equal(miss?.important, true);
	});

	it("omits turn time when the caller measured none", () => {
		assert.equal(
			renderUsage({ ...base, turnMs: undefined }).some((row) => row.label === "took"),
			false,
		);
	});
});

describe("collapsing compacted history", () => {
	const point = (id: string, from: number, count: number): CompactionPoint => ({
		id,
		summarizesFromIndex: from,
		summarizedCount: count,
	});

	it("shows everything when nothing was compacted", () => {
		const layout = layoutCompacted(10, [], true);
		assert.equal(layout.visible.length, 10);
		assert.equal(layout.dividers.length, 0);
	});

	it("collapses to one divider, not one per compaction", () => {
		// A second divider for a region the reader already cannot see leads nowhere.
		const layout = layoutCompacted(20, [point("c1", 5, 5), point("c2", 12, 7)], true);
		assert.equal(layout.dividers.length, 1);
		assert.equal(layout.dividers[0]!.atIndex, 12);
		// The collapsed region is the union of everything summarized.
		assert.equal(layout.collapsed.length, 12);
		assert.equal(layout.visible.length, 8);
	});

	it("shows a divider at every point when expanded", () => {
		// Which is what someone reading the history of a conversation needs.
		const layout = layoutCompacted(20, [point("c1", 5, 5), point("c2", 12, 7)], false);
		assert.equal(layout.dividers.length, 2);
		assert.deepEqual(
			layout.dividers.map((divider) => divider.atIndex),
			[5, 12],
		);
		assert.equal(layout.collapsed.length, 12);
	});

	it("emits no divider when there is nothing behind it", () => {
		// A compaction at index 0 summarized nothing, so a divider there goes nowhere.
		const layout = layoutCompacted(10, [point("c1", 0, 0)], true);
		assert.equal(layout.dividers.length, 0);
		assert.equal(layout.visible.length, 10);
	});

	it("handles an empty transcript", () => {
		const layout = layoutCompacted(0, [], true);
		assert.equal(layout.visible.length, 0);
	});
});

describe("tool activity", () => {
	it("honours the preference", () => {
		assert.equal(toolActivityMode("full", 2), "full");
		assert.equal(toolActivityMode("summary", 2), "summary");
		assert.equal(toolActivityMode("hidden", 2), "hidden");
	});

	it("collapses a long turn on its own", () => {
		// So the setting is a floor rather than the only mechanism.
		assert.equal(toolActivityMode("full", 50), "summary");
		assert.equal(toolActivityMode("full", 5), "full");
	});
});
