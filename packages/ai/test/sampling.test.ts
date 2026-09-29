import { describe, expect, it } from "vitest";
import {
	defaultSamplingConfig,
	describeSampling,
	PROVIDER_DEFAULT,
	resolveParameter,
	resolveSampling,
	SAMPLING_RANGES,
	type SamplingConfig,
	toRequestFields,
} from "../src/sampling.ts";

/**
 * Sampling parameters.
 *
 * The property that matters most: **unset means absent, not zero.** Sending
 * `temperature: 0` because the user never set it produces a deterministic
 * session they did not ask for.
 */

const config = (overrides: Partial<SamplingConfig> = {}): SamplingConfig => ({
	...defaultSamplingConfig(),
	...overrides,
});

describe("the negative sentinel means provider default", () => {
	it("defaults every parameter to the sentinel", () => {
		expect(Object.values(defaultSamplingConfig()).every((value) => value === PROVIDER_DEFAULT)).toBe(true);
	});

	it("omits an unset parameter rather than defaulting it", () => {
		const resolved = resolveSampling(config());
		// A provider that sees no field uses its own; one that sees 0 does not.
		expect(toRequestFields(resolved)).toEqual({});
	});

	it("omits a negative value the same way", () => {
		expect(resolveParameter("temperature", -1).value).toBeUndefined();
		expect(resolveParameter("temperature", -0.5).value).toBeUndefined();
	});

	it("sends zero when zero is what the user chose", () => {
		// Zero is a real value, and it is the one a naive `|| default` would drop.
		expect(resolveParameter("temperature", 0).value).toBe(0);
		expect(toRequestFields(resolveSampling(config({ temperature: 0 })))).toEqual({ temperature: 0 });
	});
});

describe("a value the provider would reject is dropped, not clamped", () => {
	it("rejects a topP above one", () => {
		const outcome = resolveParameter("topP", 1.5);
		expect(outcome.rejection?.reason).toBe("out-of-range");
		expect(outcome.value).toBeUndefined();
	});

	it("rejects a minP below zero", () => {
		expect(resolveParameter("minP", -0.1).rejection?.reason).toBe("out-of-range");
	});

	it("drops a rejected parameter from the request entirely", () => {
		// Sending an out-of-range value risks the provider rejecting the *whole*
		// request, which turns a typo in one setting into a failed turn.
		const resolved = resolveSampling(config({ topP: 5, temperature: 0.4 }));
		expect(toRequestFields(resolved)).toEqual({ temperature: 0.4 });
		expect(resolved.rejected).toHaveLength(1);
		expect(resolved.rejected[0]!.parameter).toBe("topP");
	});

	it("accepts a temperature above one, because providers do", () => {
		// The upper bound is not ours to impose.
		expect(resolveParameter("temperature", 1.4).value).toBe(1.4);
	});

	it("accepts any value for a parameter with no declared range", () => {
		// Several providers accept penalties below zero, and asserting a wrong
		// range would reject a legitimate value.
		expect(SAMPLING_RANGES.presencePenalty).toBeUndefined();
		expect(resolveParameter("presencePenalty", -0.5).rejection).toBeUndefined();
	});

	it("rejects a non-finite value as absence rather than as a range error", () => {
		expect(resolveParameter("temperature", Number.NaN).value).toBeUndefined();
		expect(resolveParameter("temperature", Number.POSITIVE_INFINITY).value).toBeUndefined();
	});
});

describe("every parameter uses the same sentinel", () => {
	it("has no per-parameter exception", () => {
		// A per-parameter exception is where "why is topK sent but topP not" comes
		// from, and the answer is always a bug.
		const resolved = resolveSampling(config());
		expect(Object.keys(resolved.values)).toEqual([]);
	});

	it("sends only what was set", () => {
		const resolved = resolveSampling(config({ topK: 40, topP: 0.9 }));
		expect(toRequestFields(resolved)).toEqual({ topK: 40, topP: 0.9 });
	});

	it("carries every configured value through", () => {
		const resolved = resolveSampling(
			config({ temperature: 0.2, topP: 0.95, topK: 20, minP: 0.05, presencePenalty: 0.1, repetitionPenalty: 1.1 }),
		);
		expect(Object.keys(toRequestFields(resolved)).sort()).toEqual([
			"minP",
			"presencePenalty",
			"repetitionPenalty",
			"temperature",
			"topK",
			"topP",
		]);
	});
});

describe("describing what a session sends", () => {
	it("says provider defaults when nothing is set", () => {
		expect(describeSampling(resolveSampling(config()))).toBe("sampling: provider defaults");
	});

	it("lists the set parameters", () => {
		expect(describeSampling(resolveSampling(config({ temperature: 0.3 })))).toContain("temperature=0.3");
	});

	it("leads with a rejection, because a rejected value is not sent", () => {
		const described = describeSampling(resolveSampling(config({ topP: 9 })));
		expect(described).toContain("rejected");
		expect(described).toContain("topP=9");
	});
});
