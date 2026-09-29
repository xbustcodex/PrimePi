import { describe, expect, it } from "vitest";
import {
	COMPACTION_METHOD_CHOICES,
	type CompactionMethod,
	DEFAULT_COMPACTION_METHOD_ORDER,
	isCompactionMethod,
	isMethodAvailable,
	LOCAL_COMPACTION_METHODS,
	type MethodAvailability,
	resolveCompactionMethodOrder,
	resolveSpeculationMethod,
	selectCompactionMethod,
} from "../src/utils/compaction-methods.ts";

/**
 * Compaction method selection.
 *
 * The property that matters is **exhaustion is reported, never assumed**. If
 * every configured method is unavailable or fails, the context is still full and
 * the caller has to know that. Silently continuing is how a session ends up
 * asking a model to answer with a context that no longer fits.
 */

const ALL: MethodAvailability = { remoteAvailable: true, modelAcceptsImages: true };
const NO_REMOTE: MethodAvailability = { remoteAvailable: false, modelAcceptsImages: true };
const NO_IMAGES: MethodAvailability = { remoteAvailable: true, modelAcceptsImages: false };

const never = () => undefined;
const alwaysFails = () => "the provider rejected the request";

describe("a configured order is filtered, never trusted", () => {
	it("drops unknown entries", () => {
		// A hand-edited order containing a typo degrades to the methods that exist
		// rather than throwing mid-compaction.
		expect(resolveCompactionMethodOrder(["remote", "snappcompact", "soft"])).toEqual(["remote", "soft"]);
	});

	it("collapses duplicates to the first occurrence", () => {
		// Running the same method twice would run the same compaction twice when the
		// first failure was transient.
		expect(resolveCompactionMethodOrder(["soft", "remote", "soft"])).toEqual(["soft", "remote"]);
	});

	it("returns nothing for a non-array", () => {
		expect(resolveCompactionMethodOrder("remote")).toEqual([]);
		expect(resolveCompactionMethodOrder(undefined)).toEqual([]);
	});

	it("recognises every catalogued method and nothing else", () => {
		for (const choice of COMPACTION_METHOD_CHOICES) expect(isCompactionMethod(choice.value)).toBe(true);
		expect(isCompactionMethod("nonesuch")).toBe(false);
		expect(isCompactionMethod(7)).toBe(false);
	});
});

describe("availability is checked per candidate", () => {
	it("needs a route for server compaction", () => {
		expect(isMethodAvailable("remote", ALL)).toBe(true);
		expect(isMethodAvailable("remote", NO_REMOTE)).toBe(false);
	});

	it("needs a vision model for snapcompact", () => {
		// Archiving onto bitmaps is useless to a model that cannot read them.
		expect(isMethodAvailable("snapcompact", ALL)).toBe(true);
		expect(isMethodAvailable("snapcompact", NO_IMAGES)).toBe(false);
	});

	it("treats the LLM-calling methods as always available", () => {
		// If one fails the loop advances, rather than treating it unavailable up front.
		expect(isMethodAvailable("handoff", NO_REMOTE)).toBe(true);
		expect(isMethodAvailable("soft", NO_IMAGES)).toBe(true);
		expect(isMethodAvailable("shake", NO_REMOTE)).toBe(true);
	});
});

describe("the loop stops at the first success", () => {
	it("runs the first available method", () => {
		const ran: CompactionMethod[] = [];
		const result = selectCompactionMethod({
			order: ["remote", "soft"],
			availability: ALL,
			run: (method) => {
				ran.push(method);
				return undefined;
			},
		});
		expect(result.succeeded).toBe("remote");
		expect(ran).toEqual(["remote"]);
		expect(result.exhausted).toBe(false);
	});

	it("advances past an unavailable method without running it", () => {
		const ran: CompactionMethod[] = [];
		const result = selectCompactionMethod({
			order: ["remote", "soft"],
			availability: NO_REMOTE,
			run: (method) => {
				ran.push(method);
				return undefined;
			},
		});
		// Recorded as unavailable rather than failed, so a caller can tell "cannot do
		// it" from "tried and broke".
		expect(result.attempts[0]).toMatchObject({ method: "remote", outcome: "unavailable" });
		expect(ran).toEqual(["soft"]);
		expect(result.succeeded).toBe("soft");
	});

	it("advances past a failure and keeps the reason", () => {
		const result = selectCompactionMethod({
			order: ["handoff", "soft"],
			availability: ALL,
			run: (method) => (method === "handoff" ? alwaysFails() : undefined),
		});
		expect(result.attempts[0]).toMatchObject({
			method: "handoff",
			outcome: "failed",
			reason: "the provider rejected the request",
		});
		expect(result.succeeded).toBe("soft");
	});
});

describe("exhaustion is reported, never assumed", () => {
	it("reports exhausted when every method fails", () => {
		// The context is still full. Continuing silently is how a session ends up
		// asking a model to answer with a context that no longer fits.
		const result = selectCompactionMethod({ order: ["remote", "soft"], availability: ALL, run: alwaysFails });
		expect(result.succeeded).toBeUndefined();
		expect(result.exhausted).toBe(true);
		expect(result.attempts).toHaveLength(2);
	});

	it("reports exhausted when every method is unavailable", () => {
		const result = selectCompactionMethod({
			order: ["remote", "snapcompact"],
			availability: { remoteAvailable: false, modelAcceptsImages: false },
			run: never,
		});
		expect(result.exhausted).toBe(true);
		expect(result.attempts.every((attempt) => attempt.outcome === "unavailable")).toBe(true);
	});

	it("reports exhausted for an order naming nothing real", () => {
		const result = selectCompactionMethod({ order: ["nope", "alsonope"], availability: ALL, run: never });
		expect(result.exhausted).toBe(true);
		expect(result.attempts).toEqual([]);
	});

	it("does not claim exhaustion on success", () => {
		expect(selectCompactionMethod({ order: ["soft"], availability: ALL, run: never }).exhausted).toBe(false);
	});
});

describe("only a method with latency is worth a marker", () => {
	it("names the first slow method it would reach", () => {
		expect(resolveSpeculationMethod(["remote", "soft"], ALL)).toBe("remote");
		expect(resolveSpeculationMethod(["handoff"], ALL)).toBe("handoff");
	});

	it("says nothing for a local method", () => {
		// Effectively instant, so by the time a marker could be drawn the compaction
		// has already happened.
		expect(resolveSpeculationMethod(["shake"], ALL)).toBeUndefined();
		expect(resolveSpeculationMethod(["snapcompact"], ALL)).toBeUndefined();
	});

	it("falls through a local first choice to a slow later one", () => {
		expect(resolveSpeculationMethod(["shake", "soft"], ALL)).toBeUndefined();
		expect(resolveSpeculationMethod(["shake", "soft"], ALL)).not.toBe("soft");
	});

	it("skips remote once it is known broken", () => {
		// Without this, every subsequent pass retries a method already known to fail.
		expect(resolveSpeculationMethod(["remote", "soft"], NO_REMOTE)).toBe("soft");
		expect(resolveSpeculationMethod(["remote", "soft"], ALL, { skipRemote: true })).toBe("soft");
	});

	it("says nothing when only local methods remain", () => {
		expect(resolveSpeculationMethod(["shake", "snapcompact"], ALL, { skipRemote: true })).toBeUndefined();
	});
});

describe("the default order is a cost preference", () => {
	it("puts the free server-native route first", () => {
		expect(DEFAULT_COMPACTION_METHOD_ORDER[0]).toBe("remote");
	});

	it("runs local methods before the ones that make an LLM call", () => {
		const order = DEFAULT_COMPACTION_METHOD_ORDER;
		expect(order.indexOf("shake")).toBeLessThan(order.indexOf("soft"));
		expect(order.indexOf("snapcompact")).toBeLessThan(order.indexOf("handoff"));
	});

	it("classifies the methods that cost nothing", () => {
		for (const choice of COMPACTION_METHOD_CHOICES) {
			expect(LOCAL_COMPACTION_METHODS.has(choice.value), choice.value).toBe(!choice.requiresLlmCall);
		}
	});
});
