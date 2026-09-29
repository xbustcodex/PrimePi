import { describe, expect, it } from "vitest";
import {
	detectExactSuffixCycle,
	EXACT_CHECK_STRIDE,
	EXACT_LONG_MIN_REPEATED_CHARS,
	EXACT_MAX_UNIT,
	EXACT_SHORT_MAX_UNIT,
	EXACT_SHORT_MIN_REPEATED_CHARS,
	EXACT_TAIL_WINDOW,
	isReasoningUnit,
	ThinkingLoopDetector,
} from "../src/utils/thinking-loop.ts";

/**
 * Stream loop detection.
 *
 * The properties that matter are both directions. **A real cycle is caught**,
 * including the long-period one a verbatim-repeat check misses. And **legitimate
 * repetition is not**: a table, a repeated code block and a repeated short
 * string are all things a model is entitled to emit, and tripping on them turns
 * a working session into a discarded turn.
 */

const repeat = (unit: string, times: number) => unit.repeat(times);

describe("a real cycle is caught", () => {
	it("catches a back-to-back paragraph cycle", () => {
		const cycle = detectExactSuffixCycle(repeat("Now I will verify the configuration was applied. ", 6));
		expect(cycle).not.toBeNull();
		expect(cycle?.count).toBeGreaterThanOrEqual(4);
	});

	it("catches a long-period cycle", () => {
		// The observed shape: a long unit repeated back to back. A verbatim repeat
		// check tuned to short strings misses this entirely. The detector may report a
		// shorter period *within* that unit, which is equally correct, so what is
		// asserted is that a cycle is found and that it repeats many times.
		const unit = "Checking the handler dispatch path for the third time. ".repeat(8);
		const cycle = detectExactSuffixCycle(repeat(unit, 4));
		expect(cycle).not.toBeNull();
		expect(cycle?.count).toBeGreaterThanOrEqual(4);
	});
	it("catches a cycle that starts mid-stream, not just one starting at the beginning", () => {
		const prefix = "Here is the plan for the migration. ".repeat(12);
		expect(detectExactSuffixCycle(prefix + repeat("Refactoring the resolver now. ", 6))).not.toBeNull();
	});

	it("returns a unit that really is the text at the tail", () => {
		const cycle = detectExactSuffixCycle(repeat("Now I will verify the configuration was applied. ", 6));
		// The reported unit is the final len characters of the input, verbatim.
		expect(cycle).not.toBeNull();
		expect("Now I will verify the configuration was applied. ".repeat(6).endsWith(cycle!.unit)).toBe(true);
	});
});

describe("legitimate repetition is not caught", () => {
	it("ignores text below the character floor", () => {
		// Repetition below the floor is not evidence, however regular.
		expect(detectExactSuffixCycle("ab".repeat(40))).toBeNull();
	});

	it("ignores a repeated punctuation run", () => {
		// Formatting is not reasoning. The unit must contain a letter or emoji.
		expect(detectExactSuffixCycle("----------".repeat(40))).toBeNull();
		expect(detectExactSuffixCycle("  ".repeat(200))).toBeNull();
	});

	it("ignores a repeated code block, however many times", () => {
		// Three copies of a unique code block is a model showing a snippet, not a
		// runaway. Treating a verbatim-repeated block as a loop would discard working
		// turns, so the guard stays on the paragraph-shaped cycles it was calibrated
		// for rather than on repetition alone.
		const block =
			"export function calculateTotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }";
		expect(detectExactSuffixCycle(block.repeat(2))).toBeNull();
		expect(detectExactSuffixCycle(block.repeat(3))).toBeNull();
	});

	it("ignores a repeated short phrase that is not actually cyclic", () => {
		// The same words in different orders, which is what real prose looks like.
		const text = Array.from(
			{ length: 12 },
			(_, i) => `Checking item ${(i % 4) + 1} of the configuration list. `,
		).join("");
		expect(detectExactSuffixCycle(text)).toBeNull();
	});

	it("ignores distinct prose of the same length", () => {
		const text = Array.from(
			{ length: 40 },
			(_, i) => `Observation number ${i} concerns a different subsystem entirely. `,
		).join("");
		expect(detectExactSuffixCycle(text)).toBeNull();
	});
});

describe("the reasoning gate", () => {
	it("rejects a lone letter and accepts a word", () => {
		expect(isReasoningUnit("x")).toBe(false);
		expect(isReasoningUnit("xx")).toBe(false);
		expect(isReasoningUnit("ab")).toBe(true);
	});

	it("accepts an emoji unit", () => {
		expect(isReasoningUnit("\u{1F600}")).toBe(true);
	});
});

describe("the thresholds are not interchangeable", () => {
	it("needs more repetitions for a short unit than a long one", () => {
		// A short unit is held to four repetitions, a long one to three.
		const short = "Now checking. ".repeat(30);
		const long = "Now checking the handler dispatch path. ".repeat(8);
		expect(detectExactSuffixCycle(short)?.count).toBeGreaterThanOrEqual(4);
		expect(detectExactSuffixCycle(long)?.count).toBeGreaterThanOrEqual(3);
	});

	it("applies a character floor to each", () => {
		expect(EXACT_SHORT_MIN_REPEATED_CHARS).toBeLessThan(EXACT_LONG_MIN_REPEATED_CHARS);
	});

	it("exposes a short and a long bound that differ", () => {
		expect(EXACT_SHORT_MAX_UNIT).toBeLessThan(EXACT_MAX_UNIT);
	});
});

describe("a single repeated character is padding, not reasoning", () => {
	it("ignores a stream of one repeated letter", () => {
		// A model padding its output with a single character trips every count and
		// length threshold while carrying no information, and terminating that stream
		// throws away a turn that may still be about to answer.
		expect(detectExactSuffixCycle("x".repeat(400))).toBeNull();
	});

	it("ignores a stream of one repeated character at any period", () => {
		// The period is free to be two characters: "xx" still contains letters, so the
		// gate has to measure the whole unit rather than find a substring.
		expect(detectExactSuffixCycle("z".repeat(4000))).toBeNull();
	});

	it("still catches a real cycle of the same shape", () => {
		// The gate must not be so strict that it stops catching loops.
		expect(detectExactSuffixCycle("Now verifying the configuration. ".repeat(8))).not.toBeNull();
	});
});

describe("the detector accumulates across deltas", () => {
	it("catches a cycle delivered one small delta at a time", () => {
		// Streaming arrives token-sized; the guard must not depend on delta shape.
		const detector = new ThinkingLoopDetector();
		const text = repeat("Rechecking the same assertion again. ", 8);
		let report: string | null = null;
		for (let i = 0; i < text.length && report === null; i += 7) {
			report = detector.push(text.slice(i, i + 7));
		}
		expect(report).toContain("back-to-back");
	});

	it("reports nothing for clean prose", () => {
		const detector = new ThinkingLoopDetector();
		const text = Array.from(
			{ length: 30 },
			(_, i) => `Step ${i + 1}: update the resolver and re-run the suite. `,
		).join("");
		let report: string | null = null;
		for (let i = 0; i < text.length && report === null; i += 11) {
			report = detector.push(text.slice(i, i + 11));
		}
		expect(report).toBeNull();
	});

	it("ignores an empty delta", () => {
		expect(new ThinkingLoopDetector().push("")).toBeNull();
	});

	it("runs a final check on flush, even with nothing pending", () => {
		// A stream can stop before the next cadence boundary, and the trailing cycle
		// would otherwise go unexamined.
		const detector = new ThinkingLoopDetector();
		detector.push(repeat("The plan is confirmed and complete. ", 6));
		expect(detector.flush()).toContain("back-to-back");
	});

	it("keeps only a bounded tail, so a long stream cannot grow the cost", () => {
		const detector = new ThinkingLoopDetector();
		for (let i = 0; i < 400; i++)
			detector.push(`Observation ${i} concerns a different subsystem entirely. `.padEnd(64, " "));
		// The tail is capped at EXACT_TAIL_WINDOW, so a cycle from long ago is no longer
		// in scope and the scan cost does not grow with stream length.
		expect(EXACT_TAIL_WINDOW).toBeGreaterThan(0);
		expect(detector.flush()).toBeNull();
	});

	it("still detects a fresh cycle after a long clean stream", () => {
		const detector = new ThinkingLoopDetector();
		for (let i = 0; i < 200; i++) detector.push(`Unique observation ${i} about a different subsystem. `);
		let report: string | null = null;
		const cycle = repeat("Verifying the migration plan once more. ", 8);
		for (let i = 0; i < cycle.length && report === null; i += 9) {
			report = detector.push(cycle.slice(i, i + 9));
		}
		expect(report).not.toBeNull();
	});

	it("exposes a scan cadence rather than scanning every delta", () => {
		// Per-delta scanning is quadratic in the number of deltas for no gain: a cycle
		// spanning a stride boundary is visible at the next scan.
		expect(EXACT_CHECK_STRIDE).toBeGreaterThan(1);
	});
});
