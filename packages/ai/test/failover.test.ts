import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { classifyAvailabilityFailure } from "../src/utils/availability.ts";
import { AvailabilityCooldowns, DEFAULT_UNAVAILABLE_TTL_MS } from "../src/utils/availability-cooldowns.ts";
import { policyAllowsPaid, selectFailoverCandidate } from "../src/utils/failover.ts";
import { isCredentialFree } from "../src/utils/free-model.ts";

const T0 = 1_790_398_996_120;

/** The exact body observed live from OpenRouter with the free daily pool exhausted. */
const openRouterFreeTierBody = JSON.stringify({
	error: {
		message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
		code: 429,
		metadata: {
			headers: {
				"X-RateLimit-Limit": "50",
				"X-RateLimit-Remaining": "0",
				"X-RateLimit-Reset": "1790467200000",
			},
			limit_source: "openrouter_free_tier_daily",
			remedy_hint:
				"Wait for the daily reset (see X-RateLimit-Reset), or purchase credits to raise your free-model daily limit.",
			provider_name: null,
		},
	},
	user_id: "user_test",
});

const openRouterSharedCapacityBody = JSON.stringify({
	error: {
		message: "Rate limit exceeded",
		metadata: { limit_source: "openrouter_shared_capacity" },
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

describe("classifyAvailabilityFailure", () => {
	it("treats an exhausted free daily pool as a funding-pool failure with a reset time", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${openRouterFreeTierBody}`,
			now: T0,
		});
		expect(failure).toBeDefined();
		expect(failure?.scope).toBe("funding-pool");
		expect(failure?.exhausted).toBe(true);
		expect(failure?.resetAtMs).toBe(1_790_467_200_000);
	});

	it("treats shared capacity as a narrow, retryable route failure", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${openRouterSharedCapacityBody}`,
			now: T0,
		});
		expect(failure?.scope).toBe("route");
		expect(failure?.exhausted).toBe(false);
	});

	it("falls back to model scope for unstructured transient errors", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "some/model",
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			now: T0,
		});
		expect(failure?.scope).toBe("model");
		expect(failure?.exhausted).toBe(false);
	});

	it("does not classify programming or malformed-request errors as availability failures", () => {
		for (const errorMessage of [
			"400 Invalid JSON in request body",
			"tool schema is invalid: expected object",
			"401 Unauthorized",
		]) {
			expect(
				classifyAvailabilityFailure({
					provider: "p",
					modelId: "m",
					stopReason: "error",
					errorMessage,
					now: T0,
				}),
			).toBeUndefined();
		}
	});

	it("ignores non-error stop reasons", () => {
		expect(
			classifyAvailabilityFailure({
				provider: "openrouter",
				modelId: "m",
				stopReason: "stop",
				errorMessage: openRouterFreeTierBody,
				now: T0,
			}),
		).toBeUndefined();
	});

	it("ignores the existing non-retryable limit list, which outranks transient text", () => {
		expect(
			classifyAvailabilityFailure({
				provider: "opencode",
				modelId: "m",
				stopReason: "error",
				errorMessage: "GoUsageLimitError: monthly usage limit reached",
				now: T0,
			}),
		).toBeUndefined();
	});
});

describe("AvailabilityCooldowns", () => {
	it("excludes every model sharing an exhausted funding pool", () => {
		const cooldowns = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429: ${openRouterFreeTierBody}`,
			now: T0,
		})!;
		cooldowns.record({ ...failure, now: T0 });

		// A different free model on the same account shares the pool, so it is out too.
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "qwen/qwen3.8-27b:free", now: T0 })).toBe(
			true,
		);
		// A different provider is unaffected.
		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: T0 })).toBe(false);
	});

	it("does not let a shared-capacity failure exclude sibling models", () => {
		const cooldowns = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429: ${openRouterSharedCapacityBody}`,
			now: T0,
		})!;
		cooldowns.record({ ...failure, now: T0 });

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "qwen/qwen3.8-27b:free", now: T0 })).toBe(
			false,
		);
	});

	it("expires at the provider's reset time", () => {
		const cooldowns = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "m",
			stopReason: "error",
			errorMessage: `429: ${openRouterFreeTierBody}`,
			now: T0,
		})!;
		cooldowns.record({ ...failure, now: T0 });
		const reset = failure.resetAtMs!;

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "m", now: reset - 1 })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "m", now: reset })).toBe(false);
	});

	it("uses a bounded fallback TTL when the provider gives no reset time", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			key: "model:p:m",
			scope: "model",
			reason: "transient",
			now: T0,
		});
		expect(
			cooldowns.isModelUnavailable({ provider: "p", modelId: "m", now: T0 + DEFAULT_UNAVAILABLE_TTL_MS - 1 }),
		).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "p", modelId: "m", now: T0 + DEFAULT_UNAVAILABLE_TTL_MS })).toBe(
			false,
		);
	});

	it("reports the scope in the reason for user-facing explanation", () => {
		const cooldowns = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "m",
			stopReason: "error",
			errorMessage: `429: ${openRouterFreeTierBody}`,
			now: T0,
		})!;
		cooldowns.record({ ...failure, now: T0 });
		const reasons = cooldowns.reasonsForModel({ provider: "openrouter", modelId: "m", now: T0 });
		expect(reasons[0]?.scope).toBe("funding-pool");
		expect(reasons[0]?.reason).toContain("X-RateLimit-Reset");
	});
});

describe("selectFailoverCandidate", () => {
	const cooldowns = new AvailabilityCooldowns();
	const failed = model("openrouter", "cohere/north-mini-code:free", { free: true });
	const bunny = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });
	const otherFree = model("openrouter", "qwen/qwen3.8-27b:free", { free: true });
	const paid = model("opencode", "claude-opus-5", {
		cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
	});
	const base = {
		policy: "free-only" as const,
		requirements: {},
		cooldowns,
		attempted: new Set<string>(),
		now: T0,
	};

	it("never selects a paid model when the failed model was free and policy is free-only", () => {
		const decision = selectFailoverCandidate({
			...base,
			failed,
			candidates: [{ model: paid }, { model: bunny }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
	});

	it("reports a clean stop when every usable route is exhausted", () => {
		const decision = selectFailoverCandidate({ ...base, failed, candidates: [{ model: paid }] });
		expect("unavailable" in decision).toBe(true);
		if ("unavailable" in decision) {
			expect(decision.unavailable.kind).toBe("exhausted");
			if (decision.unavailable.kind === "exhausted") {
				expect(decision.unavailable.freeRequired).toBe(true);
				expect(decision.unavailable.blocked.join(" ")).toContain("not free");
			}
		}
	});

	it("selects a paid model only under the explicit compatible policy", () => {
		expect(policyAllowsPaid("compatible")).toBe(true);
		for (const policy of ["off", "same-provider", "free-only"] as const) {
			expect(policyAllowsPaid(policy)).toBe(false);
		}
		const decision = selectFailoverCandidate({
			...base,
			policy: "compatible",
			failed,
			candidates: [{ model: paid }],
		});
		expect("model" in decision && decision.model.id).toBe("claude-opus-5");
	});

	it("does nothing when the policy is off", () => {
		const decision = selectFailoverCandidate({ ...base, policy: "off", failed, candidates: [{ model: bunny }] });
		expect("unavailable" in decision && decision.unavailable.kind).toBe("disabled");
	});

	it("stays on the same provider under the same-provider policy", () => {
		const decision = selectFailoverCandidate({
			...base,
			policy: "same-provider",
			failed,
			candidates: [{ model: bunny }, { model: otherFree }],
		});
		expect("model" in decision && decision.model.id).toBe("qwen/qwen3.8-27b:free");
	});

	it("excludes candidates missing credentials", () => {
		const decision = selectFailoverCandidate({
			...base,
			failed,
			candidates: [{ model: bunny, credentialMissing: true }],
		});
		expect("unavailable" in decision).toBe(true);
		if ("unavailable" in decision && decision.unavailable.kind === "exhausted") {
			expect(decision.unavailable.blocked.join(" ")).toContain("missing credentials");
		}
	});

	it("treats an anonymous credential-free candidate as usable, not missing credentials", () => {
		// The producer decides `credentialMissing` from real auth state; a model that
		// needs no credentials must never be marked missing just because its provider
		// has no configured key.
		const credentialMissing = !isCredentialFree(bunny) && true;
		const decision = selectFailoverCandidate({
			...base,
			failed,
			candidates: [{ model: bunny, credentialMissing }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
	});

	it("still refuses a paid candidate under free-only even when the pool is fine", () => {
		// Guards the free-stays-free invariant independently of any cooldown: a paid
		// route that is fully usable must not be selected.
		const live = new AvailabilityCooldowns();
		const decision = selectFailoverCandidate({
			...base,
			cooldowns: live,
			failed,
			candidates: [{ model: paid }, { model: bunny }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
		expect("model" in decision && decision.model.id === "claude-opus-5").toBe(false);
	});

	it("rejects an incompatible replacement for the turn's requirements", () => {
		const noTools = model("opencode", "vision-only", { free: true, api: "openrouter-images" });
		const decision = selectFailoverCandidate({
			...base,
			failed,
			requirements: { requiresTools: true },
			candidates: [{ model: noTools }, { model: bunny }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
	});

	it("rejects a replacement that cannot accept the conversation's images", () => {
		const textOnly = model("opencode", "text-only", { free: true, input: ["text"] });
		const seesImages = model("opencode", "sees-images", { free: true, input: ["text", "image"] });
		const decision = selectFailoverCandidate({
			...base,
			failed,
			requirements: { requiresImageInput: true },
			candidates: [{ model: textOnly }, { model: seesImages }],
		});
		expect("model" in decision && decision.model.id).toBe("sees-images");
	});

	it("rejects a replacement with too small a context window", () => {
		const tiny = model("opencode", "tiny", { free: true, contextWindow: 1_000 });
		const roomy = model("opencode", "roomy", { free: true, contextWindow: 1_000_000 });
		const decision = selectFailoverCandidate({
			...base,
			failed,
			requirements: { requiredContextTokens: 500_000 },
			candidates: [{ model: tiny }, { model: roomy }],
		});
		expect("model" in decision && decision.model.id).toBe("roomy");
	});

	it("rejects a replacement that cannot reason when the turn needs reasoning", () => {
		const decision = selectFailoverCandidate({
			...base,
			failed,
			requirements: { requiresReasoning: true },
			candidates: [{ model: bunny }, { model: model("opencode", "reasoner", { free: true, reasoning: true }) }],
		});
		expect("model" in decision && decision.model.id).toBe("reasoner");
	});

	it("never revisits a candidate already attempted in this cycle", () => {
		const decision = selectFailoverCandidate({
			...base,
			failed,
			candidates: [{ model: bunny }, { model: otherFree }],
			attempted: new Set(["opencode:space-bunny-free"]),
		});
		expect("model" in decision && decision.model.id).toBe("qwen/qwen3.8-27b:free");
	});

	it("terminates instead of oscillating when every candidate was already attempted", () => {
		const decision = selectFailoverCandidate({
			...base,
			failed,
			candidates: [{ model: bunny }, { model: otherFree }],
			attempted: new Set(["opencode:space-bunny-free", "openrouter:qwen/qwen3.8-27b:free"]),
		});
		expect("unavailable" in decision).toBe(true);
	});

	it("skips a candidate whose funding pool is exhausted and picks another provider", () => {
		const live = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: failed.id,
			stopReason: "error",
			errorMessage: `429: ${openRouterFreeTierBody}`,
			now: T0,
		})!;
		live.record({ ...failure, now: T0 });

		const decision = selectFailoverCandidate({
			...base,
			cooldowns: live,
			failed,
			candidates: [{ model: otherFree }, { model: bunny }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
	});
});
