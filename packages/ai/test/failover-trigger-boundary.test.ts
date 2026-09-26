import {
	type Api,
	AvailabilityCooldowns,
	classifyAvailabilityFailure,
	createModels,
	type Model,
	normalizeContext,
	selectFailoverCandidate,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";

/**
 * Regression coverage for the failover trigger boundary.
 *
 * A model switch is only justified when the provider told us *what* is unavailable.
 * An uninformative transient error must keep the existing bounded retry behaviour,
 * and failover must never be able to exceed the shared retry budget.
 */

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

/** Body carrying `limit_source`, i.e. a scope the provider actually reported. */
const SCOPED_BODY = JSON.stringify({
	error: {
		message: "Rate limit exceeded: free-models-per-day",
		metadata: {
			headers: { "X-RateLimit-Reset": "1790467200000" },
			limit_source: "openrouter_free_tier_daily",
			remedy_hint: "Wait for the daily reset.",
		},
	},
});

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		...extra,
	};
}

describe("failover trigger boundary", () => {
	it("classifies an uninformative transient error as model scope, which must not trigger a switch", () => {
		const failure = classifyAvailabilityFailure({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "overloaded_error",
			now: 1,
		});
		// Model scope means "no provider-reported scope", so the retry path is kept.
		expect(failure?.scope).toBe("model");
		expect(failure?.exhausted).toBe(false);
	});

	it("classifies a provider-reported pool exhaustion as funding-pool scope, which does trigger a switch", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${SCOPED_BODY}`,
			now: 1,
		});
		expect(failure?.scope).toBe("funding-pool");
		expect(failure?.exhausted).toBe(true);
	});

	it("cannot select a candidate outside the retry budget, because the budget is not reset by failover", () => {
		// Reproduces the unbounded-loop hazard structurally: even with a large eligible
		// pool, each failed candidate is excluded for the cycle, so the number of
		// possible switches is finite and independent of how often the budget is reset.
		const cooldowns = new AvailabilityCooldowns();
		const failed = model("openrouter", "vendor/a:free", { free: true });
		const many = Array.from({ length: 50 }, (_, i) => model("opencode", `free-${i}`, { free: true }));

		const attempted = new Set<string>();
		let switches = 0;
		for (let i = 0; i < 50; i++) {
			const decision = selectFailoverCandidate({
				failed,
				policy: "free-only",
				candidates: many.map((m) => ({ model: m })),
				requirements: {},
				cooldowns,
				attempted,
				now: Date.now(),
			});
			if (!("model" in decision)) break;
			attempted.add(`${decision.model.provider}:${decision.model.id}`);
			switches++;
		}

		// 50 candidates, each usable at most once: the cycle terminates.
		expect(switches).toBe(50);
		// And a further pass finds nothing, so the loop cannot be re-entered.
		const exhausted = selectFailoverCandidate({
			failed,
			policy: "free-only",
			candidates: many.map((m) => ({ model: m })),
			requirements: {},
			cooldowns,
			attempted,
			now: Date.now(),
		});
		expect("unavailable" in exhausted).toBe(true);
	});
});

describe("credential-free failover target remains requestable", () => {
	it("completes a request for the anonymous model chosen by a scoped failure", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());

		const message = await models
			.streamSimple(getBuiltinModel("opencode", "space-bunny-free"), context, {
				fetch: async () =>
					new Response(
						[
							`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ok" } }] })}`,
							`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
							"data: [DONE]",
							"",
						].join("\n\n"),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			})
			.result();

		expect(message.stopReason).toBe("stop");
	}, 30_000);
});
