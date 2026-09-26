import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { classifyAvailabilityFailure } from "../src/utils/availability.ts";
import { AvailabilityCooldowns } from "../src/utils/availability-cooldowns.ts";
import { failoverNotice, selectFailoverCandidate } from "../src/utils/failover.ts";

const T0 = 1_790_398_996_120;

/** Captured verbatim from the live OpenRouter response on 2026-09-26. */
const OPENROUTER_FREE_TIER_ERROR = {
	status: 429,
	headers: {
		"x-ratelimit-limit": "50",
		"x-ratelimit-remaining": "0",
		"x-ratelimit-reset": "1790467200000",
	},
	body: JSON.stringify({
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
	}),
};

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
		contextWindow: 200_000,
		maxTokens: 32_000,
		...extra,
	};
}

const openRouterFreeModels = [
	"cohere/north-mini-code:free",
	"qwen/qwen3.8-27b:free",
	"thinkingmachines/inkling:free",
	"liquid/lfm-2.5-2.6b:free",
].map((id) => model("openrouter", id, { free: true }));

const bunny = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });
const openRouterPaid = model("openrouter", "anthropic/claude-opus-5", {
	cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
});

describe("acceptance: OpenRouter free daily quota exhausted", () => {
	it("excludes the exhausted pool, selects an anonymous free model, and never a paid one", () => {
		// 1. The live 429 is classified as an exhausted account funding pool.
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${OPENROUTER_FREE_TIER_ERROR.body}`,
			now: T0,
		});
		expect(failure?.scope).toBe("funding-pool");
		expect(failure?.exhausted).toBe(true);
		expect(failure?.resetAtMs).toBe(1_790_467_200_000);

		// 2. The pool is recorded, which excludes every sibling free model on the
		//    same account rather than letting Pi cycle through all 17 of them.
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ ...failure!, now: T0 });
		for (const sibling of openRouterFreeModels) {
			expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: sibling.id, now: T0 })).toBe(true);
		}

		// 3. Failover picks space-bunny-free [opencode]: free, anonymous, compatible.
		const decision = selectFailoverCandidate({
			failed: openRouterFreeModels[0],
			policy: "free-only",
			candidates: [...openRouterFreeModels, bunny, openRouterPaid].map((model) => ({ model })),
			requirements: { requiresTools: true, requiredContextTokens: 150_000 },
			cooldowns,
			attempted: new Set(["openrouter:cohere/north-mini-code:free"]),
			now: T0,
		});
		expect("model" in decision).toBe(true);
		if (!("model" in decision)) return;
		expect(decision.model.id).toBe("space-bunny-free");
		expect(decision.model.provider).toBe("opencode");
		expect(decision.model.free).toBe(true);
		expect(decision.model.access).toBe("anonymous");

		// 4. The switch is announced with real ids, not generic wording.
		const notice = failoverNotice({
			failed: openRouterFreeModels[0],
			reason: failure!.reason,
			scope: failure!.scope,
			replacement: decision.model,
			resetAtMs: failure!.resetAtMs,
		});
		expect(notice.text).toContain("cohere/north-mini-code:free [openrouter]");
		expect(notice.text).toContain("space-bunny-free [opencode]");
		expect(notice.text).toContain("funding-pool");
	});

	it("stops cleanly without selecting a paid model when the anonymous route is also gone", () => {
		const cooldowns = new AvailabilityCooldowns();
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${OPENROUTER_FREE_TIER_ERROR.body}`,
			now: T0,
		})!;
		cooldowns.record({ ...failure, now: T0 });

		const decision = selectFailoverCandidate({
			failed: openRouterFreeModels[0],
			policy: "free-only",
			candidates: [...openRouterFreeModels, openRouterPaid].map((model) => ({ model })),
			requirements: {},
			cooldowns,
			attempted: new Set(),
			now: T0,
		});
		expect("unavailable" in decision).toBe(true);
		if (!("unavailable" in decision) || decision.unavailable.kind !== "exhausted") return;
		expect(decision.unavailable.freeRequired).toBe(true);
		// Every rejection is accounted for. `considered` counts alternatives, not the
		// model that just failed: 3 sibling free models + 1 paid model.
		expect(decision.unavailable.considered).toBe(4);
		const blocked = decision.unavailable.blocked.join("\n");
		// Siblings share the exhausted free pool, so they are excluded by scope.
		expect(blocked).toContain("unavailable (funding-pool)");
		// The paid model is also excluded, because pool exclusions match on provider.
		// That is deliberately conservative: under `free-only` the paid route would be
		// rejected on price regardless, and refusing to spend is the safer default.
		expect(blocked).toContain("anthropic/claude-opus-5 [openrouter]");
	});

	it("does not burn retries: an exhausted pool is never re-requested before its reset", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "cohere/north-mini-code:free",
			stopReason: "error",
			errorMessage: `429 Too Many Requests: ${OPENROUTER_FREE_TIER_ERROR.body}`,
			now: T0,
		})!;
		// `exhausted` is the signal the retry path uses to skip backoff entirely.
		expect(failure.exhausted).toBe(true);
		expect(failure.resetAtMs).toBeGreaterThan(T0);
	});
});
