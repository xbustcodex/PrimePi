/**
 * The retry budget is a funding boundary, so it is tested where it is actually
 * enforced: `AgentSession.prompt`, the one entry point a user reaches. Every test
 * here drives a real turn through the faux provider and reads the session's own
 * retry events, because a budget proved only against `planRetryAttempt` would say
 * nothing about whether the loop the session runs is bounded.
 *
 * What is deliberately pinned:
 *
 * - attempts are counted per request, and the count follows `retry.maxRetries`
 *   through the registry;
 * - the budget is checked before the wait, so no request can sleep past it;
 * - `retry.maxDelayMs` caps the wait that is actually emitted;
 * - a spent budget produces its own failure, distinguishable from a provider
 *   error that simply stopped being retryable;
 * - a provider-reported usage window is waited out only when
 *   `retry.waitForUsageReset` says so, and never longer than the ceiling;
 * - and none of the above widens model eligibility: `selectFailoverCandidate`
 *   stays the final authority, so a generous budget cannot buy a paid model.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function transientErrors(count: number, errorMessage = "overloaded_error") {
	return Array.from({ length: count }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
}

/**
 * A provider error carrying the structured metadata the availability classifier
 * reads. `requests_per_minute` classifies as model-scoped, so the turn stays on
 * the retry path instead of diverting into model failover, and the reported
 * `x-ratelimit-reset` gives `_prepareRetry` a real reset time to act on.
 */
function rateLimitError(resetAtMs: number): string {
	return `429 rate_limit_exceeded ${JSON.stringify({
		error: {
			metadata: {
				limit_source: "requests_per_minute",
				headers: { "x-ratelimit-reset": String(Math.floor(resetAtMs / 1000)) },
			},
		},
	})}`;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("retry budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function failing(options: Parameters<typeof createHarness>[0] = {}, responses = 12): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		harness.setResponses(transientErrors(responses));
		return harness;
	}

	it("stops a failing request at the default budget", async () => {
		const harness = await failing({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });

		await harness.session.prompt("go");

		// One initial call plus three retries: the documented default, and a hard
		// ceiling rather than "keep trying until something changes".
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("raises the attempt count with retry.maxRetries on the same path", async () => {
		const harness = await failing({ settings: { retry: { enabled: true, maxRetries: 6, baseDelayMs: 1 } } });

		await harness.session.prompt("go");

		expect(harness.faux.state.callCount).toBe(7);
	});

	it("reads a mid-session change to the budget", async () => {
		const harness = await failing({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harness.settingsManager.setSetting("retry.maxRetries", 5);

		await harness.session.prompt("go");

		expect(harness.faux.state.callCount).toBe(6);
	});

	it("treats the budget boundaries as exactly the budget", async () => {
		const none = await failing({ settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } } });
		await none.session.prompt("go");
		expect(none.faux.state.callCount).toBe(1);

		const one = await failing({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		await one.session.prompt("prompt");
		expect(one.faux.state.callCount).toBe(2);
	});

	it("does not carry one request's spending into the next", async () => {
		const harness = await failing({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });

		await harness.session.prompt("first");
		const afterFirst = harness.faux.state.callCount;
		await harness.session.prompt("second");

		// Each prompt gets its own budget: the second request is not already partly
		// spent because the first one failed.
		expect(afterFirst).toBe(3);
		expect(harness.faux.state.callCount).toBe(6);
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("caps the emitted retry delay at retry.maxDelayMs", async () => {
		const capped = await failing({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 20 } },
		});
		await capped.session.prompt("go");
		const cappedDelays = capped.eventsOfType("auto_retry_start").map((event) => event.delayMs);

		const uncapped = await failing({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 5, maxDelayMs: 0 } },
		});
		await uncapped.session.prompt("go");
		const uncappedDelays = uncapped.eventsOfType("auto_retry_start").map((event) => event.delayMs);

		// Without the ceiling the backoff grows; with it, every wait is the ceiling.
		// The capped run would sleep for 70 seconds uncapped, so the assertion is on
		// the emitted delay rather than on elapsed time.
		expect(cappedDelays).toEqual([20, 20, 20]);
		expect(uncappedDelays).toEqual([5, 10, 20]);
	});

	it("reports a spent budget as its own failure, not the provider error", async () => {
		const harness = await failing({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });

		await harness.session.prompt("go");

		const [end] = harness.eventsOfType("auto_retry_end");
		expect(end).toMatchObject({ success: false, attempt: 2, reason: "retries_exhausted" });
		expect(end.finalError).toContain("Retry budget exhausted");
		expect(end.finalError).toContain("retry.maxRetries");
		expect(end.finalError).toContain("overloaded_error");
	});

	it("distinguishes exhaustion from a failure that simply stopped being retryable", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);

		await harness.session.prompt("go");

		// Budget left unspent, so this is the provider's own verdict, not ours.
		const [end] = harness.eventsOfType("auto_retry_end");
		expect(end).toMatchObject({ success: false, attempt: 1 });
		expect(end.reason).toBeUndefined();
		expect(end.finalError).toBe("invalid_api_key");
	});

	it("waits out a reported usage window only when retry.waitForUsageReset is on", async () => {
		const resetAtMs = Date.now() + ONE_HOUR_MS;
		const waiting = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 20, waitForUsageReset: true },
			},
		});
		harnesses.push(waiting);
		waiting.setResponses(transientErrors(4, rateLimitError(resetAtMs)));

		await waiting.session.prompt("go");

		const [start] = waiting.eventsOfType("auto_retry_start");
		// The provider asked for an hour. The ceiling is 20ms, so the turn waits 20ms
		// rather than parking for the hour, and says it is waiting for the reset.
		expect(start).toMatchObject({ delayMs: 20, waitingForUsageReset: true });

		const notWaiting = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 20, waitForUsageReset: false },
			},
		});
		harnesses.push(notWaiting);
		notWaiting.setResponses(transientErrors(4, rateLimitError(resetAtMs)));

		await notWaiting.session.prompt("go");

		// Off: ordinary backoff, and no sleeping out a window we were not told to wait for.
		expect(notWaiting.eventsOfType("auto_retry_start")).toEqual([
			expect.objectContaining({ delayMs: 1, waitingForUsageReset: false }),
		]);
	});
});

describe("the retry budget is not an eligibility authority", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	const models = [
		{ id: "faux-free", free: true },
		{ id: "faux-paid", cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } },
	];

	/**
	 * A route-level capacity limit: the availability classifier calls it a
	 * provider-route failure, which is the one failure shape that sends the turn to
	 * model failover. Route scope rather than funding-pool scope matters here — a
	 * pool exclusion rules out every model on the provider, which would hide the
	 * very question being asked.
	 */
	function routeCapacityError(): string {
		return `429 rate_limit_exceeded ${JSON.stringify({
			error: { metadata: { limit_source: "shared_capacity", remedy_hint: "route is saturated" } },
		})}`;
	}

	/**
	 * The paid route is the only one on offer. That is the adversarial shape: a
	 * generous retry budget sitting next to a single candidate the eligibility
	 * authority refuses. If budget and eligibility were the same dimension, this is
	 * exactly where money would leak.
	 */
	async function onlyPaidModelAvailable(policy: "free-only" | "compatible", failures: number): Promise<Harness> {
		const harness = await createHarness({
			models,
			// No tools: an active tool set makes tool calling a turn requirement, and
			// the faux catalog declares no tool support, which would exclude every
			// candidate for a reason unrelated to the policy under test.
			tools: [],
			settings: {
				failover: policy,
				retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		const paid = harness.getModel("faux-paid");
		if (!paid) throw new Error("faux-paid was not registered");
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([paid]);
		harness.setResponses([
			...transientErrors(failures, routeCapacityError()),
			fauxAssistantMessage("recovered on a paid route"),
		]);
		return harness;
	}

	it("never spends money to recover, however large the budget", async () => {
		const harness = await onlyPaidModelAvailable("free-only", 9);

		await harness.session.prompt("go");

		// The one candidate on offer is refused, and a refusal is not something a
		// bigger budget can buy: the free-only policy is the eligibility authority and
		// the retry budget is a separate dimension.
		expect(harness.eventsOfType("auto_failover")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-free");
		expect(harness.faux.state.callCount).toBe(6);

		// Having spent its whole budget on the route that was already unavailable, the
		// turn ends by naming the budget rather than repeating the provider error.
		const [end] = harness.eventsOfType("auto_retry_end");
		expect(end).toMatchObject({ success: false, reason: "retries_exhausted" });
	});

	it("would have switched, so the refusal above is the policy and not the budget", async () => {
		const harness = await onlyPaidModelAvailable("compatible", 1);

		await harness.session.prompt("go");

		expect(harness.eventsOfType("auto_failover")).toHaveLength(1);
		expect(harness.eventsOfType("auto_failover")[0]?.to).toBe("faux:faux-paid");
		expect(harness.faux.state.callCount).toBe(2);
		// The turn only reaches its final answer by running on the paid route.
		expect(getAssistantTexts(harness)).toEqual(["recovered on a paid route"]);
	});
});
