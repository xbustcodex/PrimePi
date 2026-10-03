import { type CompactionThresholds, DEFAULT_RESERVE_TOKENS, resolveCompactionLimits } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction/compaction.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * One effective reserve, honoured by the trigger and by the compaction it selects.
 *
 * The defect this pins: `_checkCompaction` resolved the trigger policy from
 * `thresholdPercent`/`thresholdTokens` only, then **overwrote** the configured
 * `reserveTokens` with it. The setting - including the per-model override that
 * regression #8133 exists to cover - therefore decided what compaction *kept* but not
 * whether compaction *ran*.
 *
 * Semantics follow the reference implementation
 * (`oh-my-pi/packages/agent/src/compaction/compaction.ts`), which resolves one
 * `resolveThresholdTokens` and folds the reserve in only when no explicit threshold is
 * set:
 *
 *     thresholdTokens      explicit absolute trigger, priority over percent
 *     thresholdPercent     explicit proportional trigger
 *     reserveTokens        configured reserve, governs the trigger otherwise
 *     DEFAULT_RESERVE      only when the reserve was *defaulted*
 *
 * The reserve is a floor on how full the window may get, so a **larger** reserve
 * compacts **later** throughout.
 */
describe("the effective reserve is one value for the trigger and the compaction", () => {
	const resolve = (contextWindow: number, thresholds: CompactionThresholds) =>
		resolveCompactionLimits({ contextWindow, thresholds });

	describe("provenance: an explicit reserve wins even at the default value", () => {
		// These two are the reference's own regression cases, from
		// oh-my-pi/packages/agent/test/compaction-reserve-provenance.test.ts.
		it("honours an explicit reserve equal to the default on a small window", () => {
			const thresholds: CompactionThresholds = {
				thresholdPercent: -1,
				reserveTokens: DEFAULT_RESERVE_TOKENS,
			};
			const contextWindow = 19_000;
			// The user typed it, so it wins even though it equals the default and even
			// though it leaves only 2,616 tokens of budget.
			expect(resolve(contextWindow, thresholds).reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
			const settings = { enabled: true, reserveTokens: DEFAULT_RESERVE_TOKENS, keepRecentTokens: 20000 };
			expect(shouldCompact(2616, contextWindow, settings)).toBe(false);
			expect(shouldCompact(2617, contextWindow, settings)).toBe(true);
		});

		it("replaces a *defaulted* reserve that cannot fit with a proportional one", () => {
			const thresholds: CompactionThresholds = { thresholdPercent: -1 };
			const contextWindow = 19_000;
			// Identical window, but nothing was configured, so the defaulted 16,384 is
			// impossible here and 15% of the window takes over.
			const resolved = resolve(contextWindow, thresholds);
			expect(resolved.reserveTokens).toBe(2850);
			const reserveTokens = resolved.reserveTokens;
			// The trigger uses the RESOLVED reserve, which is the point: a defaulted
			// 16,384 never reaches the comparison on a 19,000 window.
			// The trigger sits at window - proportionalReserve = 19,000 - 2,850.
			const effective = { enabled: true, reserveTokens, keepRecentTokens: 20000 };
			const trigger = contextWindow - reserveTokens;
			expect(shouldCompact(trigger, contextWindow, effective)).toBe(false);
			expect(shouldCompact(trigger + 1, contextWindow, effective)).toBe(true);
		});
	});

	describe("explicit thresholds are independent triggers, not a way to derive a reserve", () => {
		it("honours an absolute token limit exactly", () => {
			const { reserveTokens } = resolve(200_000, { thresholdTokens: 50_000 });
			expect(200_000 - reserveTokens).toBe(50_000);
		});

		it("honours a percentage exactly", () => {
			const { reserveTokens } = resolve(200_000, { thresholdPercent: 40 });
			expect(200_000 - reserveTokens).toBe(80_000);
		});

		it("gives the absolute limit priority when both are configured", () => {
			const { reserveTokens, decidedBy } = resolve(200_000, { thresholdTokens: 50_000, thresholdPercent: 40 });
			expect(200_000 - reserveTokens).toBe(50_000);
			expect(decidedBy).toBe("tokens");
		});

		it("lets the percentage decide when the absolute limit is looser", () => {
			// tokens 190,000 would fire almost never; the percentage is the earlier
			// trigger and must not be ignored by the fixed limit.
			const { reserveTokens, decidedBy } = resolve(200_000, { thresholdTokens: 190_000, thresholdPercent: 40 });
			expect(200_000 - reserveTokens).toBe(80_000);
			expect(decidedBy).toBe("percent");
		});

		it("an explicit threshold still outranks an explicit reserve", () => {
			// The threshold controls *when*; the reserve controls *what is kept*. Where the
			// user configured a threshold, that is the trigger.
			const withBoth = resolve(200_000, { thresholdTokens: 50_000, reserveTokens: 20_000 });
			expect(200_000 - withBoth.reserveTokens).toBe(50_000);
		});
	});

	describe("small windows and degenerate reserves", () => {
		it("uses the proportional reserve for a defaulted reserve below the window", () => {
			const { reserveTokens } = resolve(10_000, {});
			expect(reserveTokens).toBe(1500);
			expect(10_000 - reserveTokens).toBe(8500);
		});

		it("uses the proportional reserve on a tiny window", () => {
			const { reserveTokens } = resolve(200, {});
			expect(reserveTokens).toBe(30);
			expect(200 - reserveTokens).toBeGreaterThan(0);
		});

		it("never produces a trigger at or below zero", () => {
			// A trigger of zero would make the comparison true on every turn, which is
			// the failure this whole resolution exists to prevent.
			// A 1-token window cannot have a positive trigger - there is no room for a
			// response - so the guarantee is asserted from 2 upward, and the degenerate
			// 1-token case is pinned explicitly below.
			for (const window of [2, 10, 200, 1000, 10_000, 16_384, 32_000, 200_000]) {
				for (const thresholds of [{}, { reserveTokens: window }, { reserveTokens: window * 2 }]) {
					expect(window - resolve(window, thresholds).reserveTokens, `window ${window}`).toBeGreaterThan(0);
				}
			}
		});

		it("keeps an explicit reserve that exceeds the window from firing on every turn", () => {
			// An explicit reserve the window cannot honour is still honoured for what
			// compaction keeps, but the trigger must not collapse to "always".
			const { reserveTokens } = resolve(4_000, { reserveTokens: 5_000 });
			expect(4_000 - reserveTokens).toBeGreaterThan(0);
		});

		it("pins the degenerate one-token window explicitly", () => {
			// Nothing can make a 1-token window fire late; the reserve is clamped so the
			// trigger lands at 0 rather than going negative. Recorded so the boundary is a
			// decision rather than an oversight.
			// The proportional reserve is floored at 1, so a 1-token window ends with a
			// trigger of 0 - the most degenerate value the floor permits, and the
			// boundary at which nothing further can be done.
			expect(resolve(1, {}).reserveTokens).toBe(1);
			expect(1 - resolve(1, {}).reserveTokens).toBe(0);
		});

		it("accepts a zero reserve", () => {
			// Explicitly compacting only when the context is literally full is coherent.
			const { reserveTokens } = resolve(4_000, { reserveTokens: 0 });
			expect(reserveTokens).toBe(0);
			expect(4_000 - reserveTokens).toBe(4_000);
		});
	});

	describe("exact boundary, immediately below / at / above", () => {
		it("fires strictly above the trigger and not at it", () => {
			const contextWindow = 4_000;
			const settings = { enabled: true, reserveTokens: 600, keepRecentTokens: 1 };
			const trigger = contextWindow - settings.reserveTokens;
			expect(shouldCompact(trigger - 1, contextWindow, settings)).toBe(false);
			expect(shouldCompact(trigger, contextWindow, settings)).toBe(false);
			expect(shouldCompact(trigger + 1, contextWindow, settings)).toBe(true);
		});
	});

	describe("the settings layer passes the reserve and its provenance", () => {
		it("carries a configured global reserve into the resolved trigger", () => {
			const manager = SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 900 },
			} as never);
			// A 2,000-token window with a 900 reserve fires above 1,100. Without the
			// configured reserve this defaulted to the proportional 300 and fired above 1,700.
			expect(2_000 - manager.getCompactionLimits(2_000).reserveTokens).toBe(1_100);
		});

		it("carries a per-model reserve override into the resolved trigger", () => {
			// Regression #8133. The override must change *when* compaction fires for that
			// model, not only what the compaction it already chose keeps.
			const manager = SettingsManager.inMemory({
				compaction: {
					enabled: true,
					reserveTokens: 900,
					modelOverrides: { "faux/overridden": { reserveTokens: 1_500 } },
				},
			} as never);
			expect(2_000 - manager.getCompactionLimits(2_000, { provider: "faux", id: "overridden" }).reserveTokens).toBe(
				500,
			);
			// The un-overridden model keeps the global reserve.
			expect(2_000 - manager.getCompactionLimits(2_000, { provider: "faux", id: "plain" }).reserveTokens).toBe(
				1_100,
			);
		});

		it("getCompactionSettings and getCompactionLimits agree on the reserve", () => {
			// The invariant: the reserve used to decide whether a turn needs compaction is
			// the effective reserve the compaction path is protecting.
			const manager = SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 900 },
			} as never);
			const model = { provider: "faux", id: "plain" } as never;
			const settings = manager.getCompactionSettings(model);
			const limits = manager.getCompactionLimits(4_000, model);
			expect(settings.reserveTokens).toBe(900);
			expect(limits.reserveTokens).toBe(900);
		});

		it("still applies an explicit threshold over the configured reserve", () => {
			const manager = SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 900, thresholdTokens: 2_500 },
			} as never);
			expect(4_000 - manager.getCompactionLimits(4_000).reserveTokens).toBe(2_500);
		});
	});
});
