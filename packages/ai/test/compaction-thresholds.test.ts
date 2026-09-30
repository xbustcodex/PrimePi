import { describe, expect, it } from "vitest";
import {
	DEFAULT_RESERVE_TOKENS,
	decideIdleCompaction,
	resolveCompactionLimits,
} from "../src/utils/compaction-thresholds.ts";

/**
 * Compaction thresholds.
 *
 * Two properties carry this module, and both exist because the naive reading is
 * wrong.
 *
 * **A token limit overrides a percentage** when the percentage would fire later.
 * Taking the percentage in that case silently ignores a limit the user typed,
 * and the rule reads backwards from what is intuitive.
 *
 * **An idle session below the token floor is not compacted.** The quiet period
 * can be five minutes and the context can still be small; compacting it costs an
 * LLM call to summarise almost nothing.
 */

describe("with neither limit configured", () => {
	it("uses the engine default", () => {
		const limits = resolveCompactionLimits({ contextWindow: 200_000, thresholds: {} });
		expect(limits.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
		expect(limits.decidedBy).toBe("none");
	});

	it("ignores nonsense values", () => {
		// A settings file is user input; a negative or non-numeric threshold must
		// not produce a negative reserve, which would compact on every turn.
		const limits = resolveCompactionLimits({
			contextWindow: 200_000,
			thresholds: { thresholdPercent: -5, thresholdTokens: Number.NaN },
		});
		expect(limits.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
	});
});

describe("a percentage threshold alone", () => {
	it("reserves the share below it", () => {
		// 80% of 200k leaves 40k of reserve, so compaction fires at 160k.
		const limits = resolveCompactionLimits({ contextWindow: 200_000, thresholds: { thresholdPercent: 80 } });
		expect(limits.reserveTokens).toBe(40_000);
		expect(limits.decidedBy).toBe("percent");
	});

	it("may compact later than the engine default", () => {
		// A user who sets 5% is asking to wait longer, which is a legitimate choice on
		// a large window. Clamping the reserve to the engine default would silently
		// rewrite that as 8%.
		const limits = resolveCompactionLimits({ contextWindow: 200_000, thresholds: { thresholdPercent: 5 } });
		expect(limits.reserveTokens).toBe(190_000);
		expect(limits.reserveTokens).toBeGreaterThan(DEFAULT_RESERVE_TOKENS);
	});
});

describe("a token threshold alone", () => {
	it("reserves the remainder below it", () => {
		const limits = resolveCompactionLimits({ contextWindow: 200_000, thresholds: { thresholdTokens: 120_000 } });
		expect(limits.reserveTokens).toBe(80_000);
		expect(limits.thresholdTokens).toBe(120_000);
		expect(limits.decidedBy).toBe("tokens");
	});

	it("compacts before the engine default would on a small window", () => {
		// 120k on a 128k window is far more urgent than 16k of reserve.
		const limits = resolveCompactionLimits({ contextWindow: 128_000, thresholds: { thresholdTokens: 120_000 } });
		expect(limits.reserveTokens).toBe(8_000);
	});
});

describe("a token limit overrides a percentage that would fire later", () => {
	it("takes the earlier trigger", () => {
		// 90% of 200k is 180k; the user also typed 120k. Honouring the percentage
		// would ignore the typed limit.
		const limits = resolveCompactionLimits({
			contextWindow: 200_000,
			thresholds: { thresholdPercent: 90, thresholdTokens: 120_000 },
		});
		expect(limits.reserveTokens).toBe(80_000);
		expect(limits.decidedBy).toBe("tokens");
	});

	it("takes the percentage when it fires earlier", () => {
		const limits = resolveCompactionLimits({
			contextWindow: 200_000,
			thresholds: { thresholdPercent: 50, thresholdTokens: 180_000 },
		});
		expect(limits.reserveTokens).toBe(100_000);
		expect(limits.decidedBy).toBe("percent");
	});

	it("reports both when they agree", () => {
		const limits = resolveCompactionLimits({
			contextWindow: 200_000,
			thresholds: { thresholdPercent: 60, thresholdTokens: 120_000 },
		});
		expect(limits.decidedBy).toBe("both");
	});
});

describe("a degenerate window", () => {
	it("falls back rather than dividing by zero", () => {
		const limits = resolveCompactionLimits({ contextWindow: 0, thresholds: { thresholdPercent: 80 } });
		expect(limits.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
	});

	it("never produces a negative reserve", () => {
		// A reserve above the window would make the comparison always true.
		const limits = resolveCompactionLimits({ contextWindow: 1000, thresholds: { thresholdTokens: 5_000_000 } });
		expect(limits.reserveTokens).toBeGreaterThanOrEqual(0);
	});
});

describe("idle compaction", () => {
	const base = {
		enabled: true,
		contextTokens: 300_000,
		thresholdTokens: 200_000,
		idleMs: 400_000,
		timeoutMs: 300_000,
	};

	it("compacts an idle session above the floor", () => {
		expect(decideIdleCompaction(base)).toMatchObject({ compact: true });
	});

	it("does not compact while disabled", () => {
		expect(decideIdleCompaction({ ...base, enabled: false })).toMatchObject({ compact: false, reason: "disabled" });
	});

	it("does not compact a small context however long it has been quiet", () => {
		// The cheap, decisive test first: this would cost an LLM call to summarise
		// almost nothing.
		expect(decideIdleCompaction({ ...base, contextTokens: 1_000 })).toMatchObject({
			compact: false,
			reason: "below-threshold",
		});
	});

	it("does not compact a full context that is still busy", () => {
		// Compaction rewrites the transcript, so doing it mid-turn would alter the
		// context that turn is reasoning about.
		expect(decideIdleCompaction({ ...base, idleMs: 1_000 })).toMatchObject({ compact: false, reason: "not-idle" });
	});

	it("fires exactly at the quiet period", () => {
		expect(decideIdleCompaction({ ...base, idleMs: 300_000 }).compact).toBe(true);
		expect(decideIdleCompaction({ ...base, idleMs: 299_999 }).compact).toBe(false);
	});

	it("treats a session at exactly the floor as worth compacting", () => {
		expect(decideIdleCompaction({ ...base, contextTokens: 200_000 }).compact).toBe(true);
	});
});
