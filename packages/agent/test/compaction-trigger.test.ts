import { describe, expect, it } from "vitest";
import {
	COMPACTION_METHOD_CHOICES,
	DEFAULT_COMPACTION_METHOD_ORDER,
	normaliseMethodOrder,
} from "../src/harness/compaction/methods.ts";
import {
	DEFAULT_IDLE_COMPACTION,
	DEFAULT_RESERVE_TOKENS,
	decideCompaction,
	decideIdleCompaction,
	type IdleCompaction,
	resolveCompactionThreshold,
	selectCompactionMethod,
} from "../src/harness/compaction/trigger.ts";

/**
 * Context-maintenance triggers.
 *
 * The properties that matter: the token limit overrides the percentage, an
 * unavailable method advances rather than failing, and a disabled guard produces
 * no notice, no stop and no abort.
 */

describe("two thresholds, and the token limit wins", () => {
	const window = 200_000;

	it("uses the token limit when it is set", () => {
		// The more specific statement wins: a percentage that would fire later
		// cannot override an absolute limit the user typed.
		expect(
			resolveCompactionThreshold({ thresholdPercent: 80, thresholdTokens: 50_000, contextWindowTokens: window }),
		).toEqual({
			atTokens: 50_000,
			source: "tokens",
		});
	});

	it("uses the percentage when no token limit is set", () => {
		expect(
			resolveCompactionThreshold({ thresholdPercent: 25, thresholdTokens: -1, contextWindowTokens: window }),
		).toEqual({
			atTokens: 50_000,
			source: "percent",
		});
	});

	it("falls back to the reserve when neither is set", () => {
		// The reference's default, deliberately not replaced by a percentage.
		expect(
			resolveCompactionThreshold({ thresholdPercent: -1, thresholdTokens: -1, contextWindowTokens: window }),
		).toEqual({
			atTokens: window - DEFAULT_RESERVE_TOKENS,
			source: "reserve",
		});
	});

	it("clamps a percentage into a usable range", () => {
		expect(
			resolveCompactionThreshold({ thresholdPercent: 0, thresholdTokens: -1, contextWindowTokens: window }).atTokens,
		).toBe(2_000);
		expect(
			resolveCompactionThreshold({ thresholdPercent: 500, thresholdTokens: -1, contextWindowTokens: window })
				.atTokens,
		).toBe(window);
	});

	it("falls back to the reserve when a percentage has no window to apply to", () => {
		// Rather than dividing by zero.
		const resolved = resolveCompactionThreshold({
			thresholdPercent: 50,
			thresholdTokens: -1,
			contextWindowTokens: 0,
		});
		expect(resolved.source).toBe("reserve");
		expect(resolved.atTokens).toBe(0);
	});
});

describe("deciding whether to compact now", () => {
	const thresholds = { thresholdPercent: -1, thresholdTokens: 50_000, contextWindowTokens: 200_000 };

	it("compacts at the threshold", () => {
		expect(decideCompaction({ usedTokens: 50_000, thresholds }).compact).toBe(true);
	});

	it("does not compact under it", () => {
		expect(decideCompaction({ usedTokens: 49_999, thresholds }).compact).toBe(false);
	});

	it("does nothing for an empty context", () => {
		expect(decideCompaction({ usedTokens: 0, thresholds }).reason).toContain("nothing");
	});

	it("suppresses maintenance for a turn that must not be interrupted", () => {
		// Maintenance mid-turn interrupts the turn, and a turn that must finish is
		// not a place to start summarising it.
		expect(decideCompaction({ usedTokens: 90_000, thresholds, suppressed: true }).compact).toBe(false);
	});

	it("reports the fill ratio either way", () => {
		expect(decideCompaction({ usedTokens: 100_000, thresholds }).fillRatio).toBeCloseTo(0.5);
	});
});

describe("the method order is a preference, not a requirement", () => {
	it("puts server-native first and the summarising fallback last", () => {
		// Server-native is the only method that reduces what the *provider* holds.
		expect(DEFAULT_COMPACTION_METHOD_ORDER[0]).toBe("remote");
		expect(DEFAULT_COMPACTION_METHOD_ORDER.at(-1)).toBe("soft");
		// Shake is free, so it precedes a method that costs a model call.
		expect(DEFAULT_COMPACTION_METHOD_ORDER.indexOf("shake")).toBeLessThan(
			DEFAULT_COMPACTION_METHOD_ORDER.indexOf("soft"),
		);
	});

	it("advances past an unavailable method rather than failing the turn", () => {
		// A maintenance method that cannot run must not take the session down.
		const result = selectCompactionMethod(DEFAULT_COMPACTION_METHOD_ORDER, [
			{ method: "remote", available: false, reason: "the route does not support it" },
			{ method: "snapcompact", available: false, reason: "no vision model" },
			{ method: "handoff", available: true, reason: "" },
		]);
		expect(result).toMatchObject({ method: "handoff" });
		if ("method" in result) expect(result.skipped).toHaveLength(2);
	});

	it("reports every method failing rather than continuing with a full context", () => {
		const result = selectCompactionMethod(DEFAULT_COMPACTION_METHOD_ORDER, [
			{ method: "remote", available: false, reason: "unsupported" },
			{ method: "snapcompact", available: false, reason: "unsupported" },
			{ method: "handoff", available: false, reason: "no model" },
			{ method: "shake", available: false, reason: "no heavy content" },
			{ method: "soft", available: false, reason: "no compaction model" },
		]);
		expect(result).toMatchObject({ unavailable: expect.any(Array) });
	});

	it("treats a method with no availability entry as usable", () => {
		// An unlisted method is one nothing has said is unavailable.
		expect(selectCompactionMethod(["handoff"], [])).toMatchObject({ method: "handoff" });
	});
});

describe("a hand-edited method order is normalised", () => {
	it("drops duplicates and unknown entries", () => {
		// A duplicated entry would attempt the same method twice; a misspelled one
		// would silently skip a step.
		expect(normaliseMethodOrder(["shake", "shake", "nope", "remote"])).toEqual(["shake", "remote"]);
	});

	it("restores the default when every entry was unusable", () => {
		// Running no maintenance at all is not what an empty list should mean.
		expect(normaliseMethodOrder(["nope", "also-nope"])).toEqual([...DEFAULT_COMPACTION_METHOD_ORDER]);
	});

	it("leaves a valid order alone", () => {
		expect(normaliseMethodOrder(["soft", "shake"])).toEqual(["soft", "shake"]);
	});
});

describe("idle maintenance is separate and off by default", () => {
	it("does nothing when disabled", () => {
		expect(DEFAULT_IDLE_COMPACTION.enabled).toBe(false);
		expect(decideIdleCompaction(DEFAULT_IDLE_COMPACTION, { usedTokens: 900_000, idleSeconds: 9999 }).compact).toBe(
			false,
		);
	});

	const on: IdleCompaction = { enabled: true, thresholdTokens: 50_000, delaySeconds: 300 };

	it("waits for the delay first", () => {
		expect(decideIdleCompaction(on, { usedTokens: 90_000, idleSeconds: 10 }).compact).toBe(false);
	});

	it("waits for the threshold once the delay has passed", () => {
		expect(decideIdleCompaction(on, { usedTokens: 10_000, idleSeconds: 400 }).compact).toBe(false);
	});

	it("compacts when both hold", () => {
		// Compacting while idle costs the user nothing, which is why it is separate
		// rather than a variation on the in-turn trigger.
		expect(decideIdleCompaction(on, { usedTokens: 90_000, idleSeconds: 400 }).compact).toBe(true);
	});
});

describe("the choices a settings row presents", () => {
	it("describes every method it offers", () => {
		for (const choice of COMPACTION_METHOD_CHOICES) {
			expect(choice.label.length, choice.value).toBeGreaterThan(0);
			expect(choice.description.length, choice.value).toBeGreaterThan(10);
		}
		expect(COMPACTION_METHOD_CHOICES.map((choice) => choice.value).sort()).toEqual(
			[...DEFAULT_COMPACTION_METHOD_ORDER].sort(),
		);
	});
});
