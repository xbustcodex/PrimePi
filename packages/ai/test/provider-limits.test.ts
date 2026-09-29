import { describe, expect, it } from "vitest";
import {
	admitRequest,
	backoffMs,
	describeLimits,
	InvalidProviderLimitError,
	limitFor,
	validateProviderLimits,
} from "../src/utils/provider-limits.ts";

/**
 * Per-provider in-flight limits.
 *
 * The property that matters: **the effective limit is the smaller of the
 * configured one and the provider's own ceiling.** A local limit above what the
 * provider allows produces rate-limit errors rather than throughput, and a
 * rate-limit error costs the request, not just the queue slot.
 */

describe("a limit is validated, not coerced", () => {
	it("accepts positive numbers", () => {
		expect(validateProviderLimits({ openai: 4, anthropic: 2 })).toEqual({ openai: 4, anthropic: 2 });
	});

	it("rejects zero, negative and non-numbers by name", () => {
		// Coercing 0 to unlimited silently discards a value the user typed; coercing
		// it to "no requests" hangs every request.
		expect(() => validateProviderLimits({ openai: 0 })).toThrow(InvalidProviderLimitError);
		expect(() => validateProviderLimits({ openai: -1 })).toThrow(InvalidProviderLimitError);
		expect(() => validateProviderLimits({ openai: "4" })).toThrow(InvalidProviderLimitError);
	});

	it("names the providers at fault, so a typo is findable", () => {
		try {
			validateProviderLimits({ openai: 2, anthropic: 0, brave: -1 });
			throw new Error("expected a rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidProviderLimitError);
			// A silently-ignored limit means the user believes they are protected and
			// are not.
			expect((error as InvalidProviderLimitError).providers).toEqual(["anthropic", "brave"]);
		}
	});

	it("treats a non-record as no limits at all", () => {
		expect(validateProviderLimits(undefined)).toEqual({});
		expect(validateProviderLimits([1, 2])).toEqual({});
	});

	it("reads a limit, or reports none", () => {
		expect(limitFor({ openai: 4 }, "openai")).toBe(4);
		// A provider with no entry is unlimited, because a limit nobody asked for is
		// a limit nobody can explain.
		expect(limitFor({ openai: 4 }, "anthropic")).toBeUndefined();
	});
});

describe("admission", () => {
	it("admits below the limit", () => {
		const decision = admitRequest({ limits: { openai: 2 }, usage: { provider: "openai", inFlight: 1 } });
		expect(decision.admit).toBe(true);
	});

	it("refuses at the limit and says what is in flight", () => {
		const decision = admitRequest({ limits: { openai: 2 }, usage: { provider: "openai", inFlight: 2 } });
		expect(decision.admit).toBe(false);
		if (decision.admit) return;
		expect(decision.reason).toContain("2 of 2");
	});

	it("admits an unlimited provider whatever the count", () => {
		expect(admitRequest({ limits: {}, usage: { provider: "openai", inFlight: 99 } }).admit).toBe(true);
		expect(admitRequest({ limits: { anthropic: 1 }, usage: { provider: "openai", inFlight: 99 } }).admit).toBe(true);
	});

	it("never exceeds the provider's own ceiling", () => {
		// A local limit above what the provider allows produces rate-limit errors
		// rather than throughput, and the error costs the request.
		const decision = admitRequest({
			limits: { openai: 10 },
			usage: { provider: "openai", inFlight: 2, providerCeiling: 2 },
		});
		expect(decision.admit).toBe(false);
		if (decision.admit) return;
		expect(decision.limit).toBe(2);
		expect(decision.reason).toContain("own ceiling");
	});

	it("uses the local limit when it is the tighter one", () => {
		const decision = admitRequest({
			limits: { openai: 1 },
			usage: { provider: "openai", inFlight: 1, providerCeiling: 50 },
		});
		expect(decision.admit).toBe(false);
		if (decision.admit) return;
		expect(decision.limit).toBe(1);
	});
});

describe("backoff", () => {
	it("is zero on the first attempt", () => {
		expect(backoffMs(0)).toBe(0);
	});

	it("grows with the queue depth", () => {
		// A fixed wait for a deep queue retries into the same wall.
		expect(backoffMs(5)).toBeGreaterThan(backoffMs(2));
	});

	it("is bounded, so a stuck provider stalls nothing indefinitely", () => {
		expect(backoffMs(50)).toBeLessThanOrEqual(10_000);
		expect(backoffMs(500)).toBeLessThanOrEqual(10_000);
	});

	it("jitters, so waiters do not retry in lockstep", () => {
		// A burst retrying together re-creates the contention it is waiting out.
		const samples = new Set(Array.from({ length: 8 }, () => backoffMs(4)));
		expect(samples.size).toBeGreaterThan(1);
	});
});

describe("the hint says what unlimited means", () => {
	it("names the limited providers", () => {
		expect(describeLimits({ openai: 2, anthropic: 1 })).toContain("openai, anthropic");
	});

	it("says a provider with no entry is unlimited", () => {
		expect(describeLimits({ openai: 2 })).toContain("unlimited");
	});

	it("says plainly when nothing is limited", () => {
		expect(describeLimits({})).toContain("No provider is limited");
	});
});
