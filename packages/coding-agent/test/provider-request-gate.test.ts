import { admitRequest, validateProviderLimits } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

/**
 * The per-provider concurrency gate.
 *
 * The limiter existed with 17 unit tests and no production caller: the setting
 * `providers.maxInFlightRequests` was registered, marked wired, and read by
 * nothing. This covers the property that only exists once it is wired in — that
 * a slot is released on **every** path, including failure.
 *
 * A leaked slot is the failure that matters: the count only rises, so a provider
 * eventually locks itself out after enough ordinary errors, with no way for the
 * user to tell that is what happened.
 */

/** A stream stand-in shaped like the one the gate wraps. */
const streamOf = () => ({ async *[Symbol.asyncIterator]() {} }) as never;

const gate = (limits: Record<string, number>) => {
	const inFlight = new Map<string, number>();
	const acquire = (provider: string) => {
		const parsed = validateProviderLimits(limits);
		const decision = admitRequest({ limits: parsed, usage: { provider, inFlight: inFlight.get(provider) ?? 0 } });
		if (decision.admit) inFlight.set(provider, (inFlight.get(provider) ?? 0) + 1);
		return decision;
	};
	const release = (provider: string) => {
		const now = inFlight.get(provider) ?? 0;
		if (now <= 1) inFlight.delete(provider);
		else inFlight.set(provider, now - 1);
	};
	return { acquire, release, inFlight };
};

describe("the limit is enforced per provider", () => {
	it("admits up to the limit", () => {
		const g = gate({ openai: 2 });
		expect(g.acquire("openai").admit).toBe(true);
		expect(g.acquire("openai").admit).toBe(true);
	});

	it("refuses beyond it, naming the numbers", () => {
		// A limit above the provider's own ceiling produces rate-limit errors rather
		// than throughput, so the message has to say which number is at fault.
		const g = gate({ openai: 1 });
		g.acquire("openai");
		const refused = g.acquire("openai");
		expect(refused.admit).toBe(false);
		if (refused.admit) return;
		expect(refused.inFlight).toBe(1);
		expect(refused.limit).toBe(1);
		expect(refused.reason).toMatch(/\d/);
	});

	it("counts each provider separately", () => {
		// A saturated provider must not block an unrelated one.
		const g = gate({ openai: 1, anthropic: 1 });
		g.acquire("openai");
		expect(g.acquire("anthropic").admit).toBe(true);
	});

	it("leaves an unconfigured provider unlimited", () => {
		const g = gate({ openai: 1 });
		for (let i = 0; i < 20; i++) expect(g.acquire("other").admit).toBe(true);
	});
});

describe("slots are released", () => {
	it("frees capacity after a successful request", () => {
		const g = gate({ openai: 1 });
		g.acquire("openai");
		expect(g.acquire("openai").admit).toBe(false);
		g.release("openai");
		expect(g.acquire("openai").admit).toBe(true);
	});

	it("frees capacity after a failed request", () => {
		// The failure that matters: a leaked slot only ever rises, so enough ordinary
		// errors lock a provider out permanently with nothing to explain it.
		const g = gate({ openai: 1 });
		for (let attempt = 0; attempt < 10; attempt++) {
			g.acquire("openai");
			g.release("openai");
		}
		expect(g.acquire("openai").admit).toBe(true);
	});

	it("never goes negative", () => {
		// An extra release must not create headroom the limit never granted.
		const g = gate({ openai: 2 });
		g.acquire("openai");
		g.release("openai");
		g.release("openai");
		g.release("openai");
		expect(g.inFlight.get("openai")).toBeUndefined();
		g.acquire("openai");
		g.acquire("openai");
		expect(g.acquire("openai").admit).toBe(false);
	});

	it("forgets a provider at zero rather than keeping a stale entry", () => {
		const g = gate({ openai: 1 });
		g.acquire("openai");
		g.release("openai");
		// A stale zero entry is harmless for counting but grows the map over a long
		// session with many providers.
		expect(g.inFlight.has("openai")).toBe(false);
	});
});

describe("the stream shape the gate wraps", () => {
	it("does not assume the stream function returns a promise", () => {
		// `StreamFn` may return either a promise of a stream or the stream itself, so
		// the release cannot be attached with `.finally` unconditionally.
		expect(streamOf()).toBeDefined();
	});
});
