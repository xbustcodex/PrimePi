import { describe, expect, it } from "vitest";
import {
	alreadySpilled,
	clampLineWidth,
	ELISION_MARKER,
	enforceInlineByteCap,
	INLINE_CAP_SLACK_BYTES,
	inlineByteCap,
	planSpill,
	type SpillConfig,
	spillConfigFrom,
} from "../src/tools/artifact-spill.ts";

/**
 * Artifact spill.
 *
 * The properties that matter: a result within the threshold is untouched, the
 * head and tail are both kept, and a tool that already spilled is never spilled
 * again - because a second save produces a reference that disagrees with the
 * first.
 */

const config = (overrides: Partial<SpillConfig> = {}): SpillConfig => ({
	thresholdBytes: 100,
	headBytes: 50,
	tailBytes: 50,
	tailLines: 5,
	maxColumns: 0,
	...overrides,
});

/** A body of `lines` lines, each `width` characters. */
function body(lines: number, width: number): string {
	return Array.from({ length: lines }, (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(width)}`).join(
		"\n",
	);
}

describe("a result within the threshold is untouched", () => {
	it("does not spill a small result", () => {
		const text = "short output";
		const plan = planSpill({ text, config: config(), alreadySpilled: false });
		expect(plan.spill).toBe(false);
		expect(plan.text).toBe(text);
	});

	it("measures bytes, not characters", () => {
		// A multi-byte result can exceed the threshold in bytes while looking small.
		const text = "é".repeat(80);
		expect(planSpill({ text, config: config({ thresholdBytes: 100 }), alreadySpilled: false }).spill).toBe(true);
	});
});

describe("head and tail are both kept", () => {
	it("keeps the beginning and the end around an elision marker", () => {
		// The head carries the command and the first failures; the tail carries the
		// summary and the exit status. The middle is the repetitive part.
		const plan = planSpill({
			text: body(40, 20),
			config: config(),
			alreadySpilled: false,
			artifactRef: "artifact://7",
		});
		expect(plan.spill).toBe(true);
		expect(plan.text).toContain(ELISION_MARKER);
		expect(plan.text).toContain("artifact://7");
		expect(plan.text.startsWith("0000")).toBe(true);
	});

	it("falls back to tail-only when the head is disabled", () => {
		// Right for a result whose end matters and whose start is noise.
		const plan = planSpill({ text: body(40, 20), config: config({ headBytes: 0 }), alreadySpilled: false });
		expect(plan.spill).toBe(true);
		expect(plan.text).toContain(ELISION_MARKER);
		expect(plan.text.startsWith("0000")).toBe(false);
	});

	it("keeps the whole result when head and tail would cover it", () => {
		// Barely over the threshold: the two views overlap, so keeping it whole is
		// both smaller and more faithful.
		const text = body(3, 60);
		const plan = planSpill({ text, config: config({ headBytes: 200, tailBytes: 200 }), alreadySpilled: false });
		expect(plan.spill).toBe(true);
		expect(plan.text).toBe(text);
	});

	it("applies the line budget before the byte budget", () => {
		// The line budget counts *lines*, and truncating bytes first would change
		// how many lines the reader sees.
		const plan = planSpill({
			text: body(20, 10),
			config: config({ tailLines: 2, tailBytes: 0, headBytes: 0 }),
			alreadySpilled: false,
		});
		expect(plan.text.split("\n").filter((line) => line.startsWith("00"))).toHaveLength(2);
	});
});

describe("a tool that already spilled is left alone", () => {
	it("does not spill a result the tool already handled", () => {
		// Re-spilling produces a second artifact whose reference disagrees with the
		// first, which is the mismatch the inline cap's slack exists to prevent.
		const text = body(40, 20);
		const plan = planSpill({ text, config: config(), alreadySpilled: true, artifactRef: "artifact://3" });
		expect(plan.spill).toBe(false);
		expect(plan.text).toBe(text);
		expect(plan.reason).toContain("already");
	});

	it("detects the internal-source metadata that marks a spill", () => {
		expect(alreadySpilled({ details: { meta: { source: { type: "internal" } } } })).toBe(true);
		expect(alreadySpilled({ details: { meta: { source: { type: "tool" } } } })).toBe(false);
		expect(alreadySpilled({})).toBe(false);
	});
});

describe("the column cap", () => {
	it("clamps a long line", () => {
		expect(clampLineWidth("abcdefghij", 5)).toBe("abcd…");
	});

	it("leaves a short line alone", () => {
		expect(clampLineWidth("abc", 5)).toBe("abc");
	});

	it("is a no-op when disabled", () => {
		expect(clampLineWidth("abcdefghij", 0)).toBe("abcdefghij");
	});

	it("always keeps at least one character", () => {
		// A zero-width result would be an empty line, which is worse than a wide one.
		expect(clampLineWidth("abcdef", 1)).toBe("a…");
	});
});

describe("the inline cap is a last resort with slack", () => {
	it("sits above the threshold by exactly the notice slack", () => {
		// Wall time, exit code, the elision marker and the artifact footer all ride
		// above the inline body; without the slack they would trip the cap and cause
		// a re-truncation of a result the sink already handled.
		expect(inlineByteCap(config({ thresholdBytes: 1000 }))).toBe(1000 + INLINE_CAP_SLACK_BYTES);
	});

	it("leaves a body that fits", () => {
		const text = "x".repeat(100);
		expect(enforceInlineByteCap(text, config({ thresholdBytes: 1000 }))).toBe(text);
	});

	it("accounts for notice bytes when deciding", () => {
		// The cap is threshold plus 2 KB of slack, so the body must exceed that before
		// anything is cut; a body just over the threshold still fits.
		const text = "x".repeat(5000);
		const config_ = config({ thresholdBytes: 1000 });
		expect(enforceInlineByteCap(text, config_).length).toBeLessThan(text.length);
		// The notice consumes part of the budget, so the body is correspondingly smaller.
		expect(enforceInlineByteCap(text, config_, 500).length).toBeLessThan(enforceInlineByteCap(text, config_).length);
	});

	it("still bounds at a zero threshold, because the cap is threshold plus slack", () => {
		// A zero threshold means "never spill", not "never bound": the slack alone is
		// a 2 KB ceiling, and conflating them would make one setting mean both.
		const text = "x".repeat(100_000);
		const capped = enforceInlineByteCap(text, config({ thresholdBytes: 0 }));
		expect(capped).not.toBe(text);
		// The ceiling is the slack alone, plus the truncation notice.
		expect(capped.length).toBeLessThan(INLINE_CAP_SLACK_BYTES + 100);
	});
});

describe("settings are expressed in kilobytes", () => {
	it("converts and floors at zero", () => {
		const built = spillConfigFrom({ thresholdKb: 50, headKb: 2.5, tailKb: 1, tailLines: 20, maxColumns: 200 });
		expect(built.thresholdBytes).toBe(50 * 1024);
		expect(built.headBytes).toBe(2.5 * 1024);
		// A negative setting is a configuration error, and a negative byte budget
		// would invert every comparison in the planner.
		expect(
			spillConfigFrom({ thresholdKb: -1, headKb: -1, tailKb: -1, tailLines: -1, maxColumns: -1 }).thresholdBytes,
		).toBe(0);
	});
});
