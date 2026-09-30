import { describe, expect, it } from "vitest";
import { clipColumns, DEFAULT_OUTPUT_SPILL, type OutputSpillSettings, spillOutput } from "../src/utils/output-spill.ts";

/**
 * Output spill.
 *
 * The threshold and the budgets answer different questions, and a test that
 * conflates them proves nothing. **The threshold** decides whether a result is
 * returned inline at all. **The budgets** decide how much survives once it is.
 *
 * So every fixture below is built to make one limit the binding constraint and
 * the other slack: a threshold test uses generous budgets, and a budget test sits
 * barely over the threshold. A fixture dominated by the other limit passes
 * whatever the code does, which is how a broken setting can look wired.
 */

const settings = (overrides: Partial<OutputSpillSettings> = {}): OutputSpillSettings => ({
	...DEFAULT_OUTPUT_SPILL,
	...overrides,
});

/** Lines of a known width, so byte arithmetic in a test is checkable by hand. */
const lines = (count: number, width = 40) =>
	Array.from({ length: count }, (_, i) => `line${String(i).padStart(6, "0")}${"x".repeat(width)}`).join("\n");

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the threshold decides whether, and it is binding here", () => {
	// Budgets generous but still smaller than the content, so the threshold
	// triggers AND something is genuinely elided. A budget larger than the content
	// is a different case entirely: nothing is removed, so there is nothing to mark.
	const generous = { headBytes: 700, tailBytes: 700, tailLines: 4 };

	it("returns a result under the threshold whole", () => {
		const content = lines(100);
		const result = spillOutput(content, settings({ spillThresholdKb: 50, ...generous }));
		expect(result.spilled).toBe(false);
		expect(result.content).toBe(content);
	});

	it("spills a result over the threshold with budgets that still elide", () => {
		// The threshold is what admits this to the spill path at all; the budgets then
		// decide how much of it survives.
		const result = spillOutput(lines(4000), settings({ spillThresholdKb: 1, ...generous }));
		expect(result.spilled).toBe(true);
		expect(result.direction).toBe("middle");
	});

	it("spills a result that sits between two thresholds", () => {
		// Same content, same budgets; only the threshold differs. This is the only
		// shape in which the threshold is provably the binding constraint: a fixture
		// where the budgets already elide cannot distinguish the two.
		const content = lines(300);
		const below = spillOutput(content, settings({ spillThresholdKb: 100, ...generous }));
		const above = spillOutput(content, settings({ spillThresholdKb: 1, ...generous }));
		expect(below.spilled).toBe(false);
		expect(above.spilled).toBe(true);
	});

	it("honours a fractional threshold as written", () => {
		// The setting offers 2.5 KB, so truncating to 2 would make a documented value
		// mean something other than what it says. A payload between the two must spill
		// at 2 and pass whole at 2.5 — which is only observable because the budgets are
		// held fixed.
		// 2419 bytes: over the 2 KB threshold, under 2.5 KB, and far wider than the
		// budgets, so both thresholds differ in effect and neither is masked.
		const content = lines(220, 0);
		const at2 = spillOutput(content, settings({ spillThresholdKb: 2, ...generous }));
		const at2Point5 = spillOutput(content, settings({ spillThresholdKb: 2.5, ...generous }));
		expect(bytes(content)).toBeGreaterThan(2 * 1024);
		expect(bytes(content)).toBeLessThan(2.5 * 1024);
		// Admitted to the spill path at 2 KB and passed whole at 2.5 KB. Truncating the
		// threshold would make both behave identically and the option a lie.
		expect(at2.spilled).toBe(true);
		expect(at2Point5.spilled).toBe(false);
		expect(at2Point5.content).toBe(content);
	});
});

describe("the budgets decide how much, and they are binding here", () => {
	// Barely over the threshold, so the threshold triggers and nothing else masks it.
	const overThreshold = { spillThresholdKb: 1 };

	it("keeps no more than the head budget plus the tail budget", () => {
		const result = spillOutput(
			lines(4000),
			settings({ ...overThreshold, headBytes: 2000, tailBytes: 2000, tailLines: 20 }),
		);
		const body = result.content.split("\n\n[…")[0] ?? "";
		expect(bytes(body)).toBeLessThanOrEqual(2000);
	});

	it("grows the kept head when the head budget grows", () => {
		const content = lines(4000);
		const small = spillOutput(content, settings({ ...overThreshold, headBytes: 500, tailBytes: 500, tailLines: 10 }));
		const large = spillOutput(
			content,
			settings({ ...overThreshold, headBytes: 5000, tailBytes: 500, tailLines: 10 }),
		);
		// Otherwise the head budget is decorative.
		expect(large.headLines ?? 0).toBeGreaterThan(small.headLines ?? 0);
	});

	it("grows the kept tail when the tail budget grows", () => {
		const content = lines(4000);
		const small = spillOutput(
			content,
			settings({ ...overThreshold, headBytes: 500, tailBytes: 500, tailLines: 5000 }),
		);
		const large = spillOutput(
			content,
			settings({ ...overThreshold, headBytes: 500, tailBytes: 20_000, tailLines: 5000 }),
		);
		expect(large.tailLines ?? 0).toBeGreaterThan(small.tailLines ?? 0);
	});

	it("bounds the tail by lines even when its byte budget is generous", () => {
		// A tail of very short lines can be large in bytes and still be many lines,
		// and the line bound is what stops that.
		const content = Array.from({ length: 4000 }, (_, i) => `s${i}`).join("\n");
		const result = spillOutput(
			content,
			settings({ ...overThreshold, headBytes: 500, tailBytes: 10_000_000, tailLines: 5 }),
		);
		expect(result.tailLines).toBeLessThanOrEqual(5);
	});
});

describe("a head budget of zero means tail-only", () => {
	it("keeps the end and drops the start", () => {
		// A real configuration, not a degenerate one: for a stream where only the
		// final state matters the head is pure cost.
		const content = `FIRST\n${"middle\n".repeat(2000)}LAST`;
		const result = spillOutput(
			content,
			settings({ spillThresholdKb: 1, headBytes: 0, tailBytes: 400, tailLines: 5 }),
		);
		expect(result.direction).toBe("tail");
		expect(result.content).toContain("LAST");
		expect(result.content).not.toContain("FIRST");
	});
});

describe("both ends are kept under middle elision", () => {
	it("retains the first and last lines", () => {
		// A build log's setup is at the top and its error is at the bottom; keeping
		// either end alone discards the half that explains the other.
		const content = `FIRSTLINE\n${"middle\n".repeat(2000)}LASTLINE`;
		const result = spillOutput(
			content,
			settings({ spillThresholdKb: 1, headBytes: 400, tailBytes: 400, tailLines: 5 }),
		);
		expect(result.direction).toBe("middle");
		expect(result.content).toContain("FIRSTLINE");
		expect(result.content).toContain("LASTLINE");
	});
});

describe("elision is reported as a count", () => {
	it("names how many lines went missing", () => {
		// A model can act on "400 lines are missing" and re-read them. A silent gap
		// tells it the output simply ended there.
		const result = spillOutput(
			lines(4000),
			settings({ spillThresholdKb: 1, headBytes: 500, tailBytes: 500, tailLines: 10 }),
		);
		expect(result.content).toMatch(/\d+ lines elided/);
	});

	it("the count matches the accounting", () => {
		const result = spillOutput(
			lines(4000),
			settings({ spillThresholdKb: 1, headBytes: 500, tailBytes: 500, tailLines: 10 }),
		);
		const elided = result.totalLines - (result.headLines ?? 0) - (result.tailLines ?? 0);
		expect(result.content).toContain(`${elided} lines elided`);
	});
});

describe("a budget wide enough for everything is not a spill", () => {
	it("returns the content rather than inserting a false marker", () => {
		// Reporting a spill here would claim lines were dropped when none were.
		const content = lines(50);
		const result = spillOutput(
			content,
			settings({ spillThresholdKb: 1, headBytes: 1_000_000, tailBytes: 1_000_000, tailLines: 1000 }),
		);
		expect(result.spilled).toBe(false);
		expect(result.content).toBe(content);
	});
});

describe("line accounting", () => {
	it("does not count a trailing newline as a line", () => {
		expect(spillOutput("a\nb\n", settings({ spillThresholdKb: 100 })).totalLines).toBe(2);
	});

	it("counts an empty result as zero lines", () => {
		expect(spillOutput("", settings()).totalLines).toBe(0);
	});
});

describe("column clipping is separate from spilling", () => {
	it("clips a line that is too wide", () => {
		// A minified bundle would otherwise consume the entire budget by itself.
		const result = clipColumns("x".repeat(100), 10);
		expect(result.clipped).toBe(true);
		expect(result.content).toContain("line clipped at 10 columns");
	});

	it("leaves a narrow line alone", () => {
		expect(clipColumns("short", 10)).toEqual({ content: "short", clipped: false });
	});

	it("treats a nonsense limit as no limit", () => {
		// A user who typed nonsense meant to relax it, not to erase the output.
		expect(clipColumns("keep me", 0).clipped).toBe(false);
		expect(clipColumns("keep me", -1).clipped).toBe(false);
		expect(clipColumns("keep me", Number.NaN).clipped).toBe(false);
	});

	it("clips each line independently", () => {
		expect(clipColumns(`${"a".repeat(20)}\nbbb`, 5).content.split("\n")).toHaveLength(2);
	});
});

describe("the defaults are coherent", () => {
	it("splits the budget evenly between the two ends", () => {
		expect(DEFAULT_OUTPUT_SPILL.headBytes).toBe(DEFAULT_OUTPUT_SPILL.tailBytes);
	});

	it("keeps the two ends within the threshold", () => {
		expect(DEFAULT_OUTPUT_SPILL.headBytes + DEFAULT_OUTPUT_SPILL.tailBytes).toBeLessThanOrEqual(
			DEFAULT_OUTPUT_SPILL.spillThresholdKb * 1024,
		);
	});
});
