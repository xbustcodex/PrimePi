import { DEFAULT_RESERVE_TOKENS, resolveCompactionLimits } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction/compaction.ts";

/**
 * The default reserve must not outrun the window it is compared against.
 *
 * `shouldCompact` fires on `contextTokens > contextWindow - reserveTokens`. With no
 * configured threshold the resolver returned `DEFAULT_RESERVE_TOKENS` (16,384)
 * unclamped, so on any model with a smaller context window the right-hand side was
 * **negative** and compaction ran on every single turn — however small the context.
 *
 * Found through six failing tests across two suites, each reporting only "an unexpected
 * compaction happened", which reads like a threshold genuinely being crossed.
 */
describe("the default reserve on a window that cannot hold it", () => {
	const enabled = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };

	it("does not fire for a small context in a window below the default reserve", () => {
		// The property that was broken: a 2,373-token context in a 10,000-token window.
		// The context must fit the window, or compaction is correct - so each case uses a
		// context well inside the window it is compared against.
		for (const [contextWindow, contextTokens] of [
			[2_000, 500],
			[5_000, 2_373],
			[10_000, 2_373],
			[DEFAULT_RESERVE_TOKENS, 2_373],
		] as const) {
			const limits = resolveCompactionLimits({ contextWindow, thresholds: {} });
			expect(
				shouldCompact(contextTokens, contextWindow, { ...enabled, reserveTokens: limits.reserveTokens }),
				`compacted a ${contextTokens}-token context in a ${contextWindow}-token window`,
			).toBe(false);
		}
	});

	it("still fires once the context is genuinely most of the window", () => {
		// Not "never" — the fix has to degrade to a proportion, not disable compaction.
		const contextWindow = 10_000;
		const limits = resolveCompactionLimits({ contextWindow, thresholds: {} });
		expect(shouldCompact(contextWindow, contextWindow, { ...enabled, reserveTokens: limits.reserveTokens })).toBe(
			true,
		);
	});

	it("never produces a negative reserve, which would fire unconditionally", () => {
		// The exact arithmetic of the original defect, asserted directly.
		for (const contextWindow of [200, 1_000, 5_000, 10_000, 16_384, 32_000, 200_000]) {
			const limits = resolveCompactionLimits({ contextWindow, thresholds: {} });
			expect(
				contextWindow - limits.reserveTokens,
				`window ${contextWindow} yields a trigger below zero`,
			).toBeGreaterThan(0);
			// And a trigger at zero would fire for any context above zero tokens.
			expect(limits.reserveTokens).toBeLessThan(contextWindow);
		}
	});

	it("leaves a window that can hold the default reserve untouched", () => {
		// No regression on the large-window path, which is what most sessions use.
		for (const contextWindow of [32_000, 200_000]) {
			const limits = resolveCompactionLimits({ contextWindow, thresholds: {} });
			expect(limits.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
			expect(limits.decidedBy).toBe("none");
		}
	});

	it("leaves a configured threshold untouched", () => {
		const percent = resolveCompactionLimits({ contextWindow: 200_000, thresholds: { thresholdPercent: 40 } });
		expect(200_000 - percent.reserveTokens).toBe(80_000);
		const tokens = resolveCompactionLimits({ contextWindow: 200_000, thresholds: { thresholdTokens: 50_000 } });
		expect(200_000 - tokens.reserveTokens).toBe(50_000);
	});
});
