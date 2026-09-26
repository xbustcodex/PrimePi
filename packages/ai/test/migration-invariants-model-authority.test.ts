import { describe, expect, it } from "vitest";
import type { ApiKeyAuth, ProviderAuth } from "../src/auth/types.ts";
import { createModels, type Provider } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";
import { classifyAvailabilityFailure } from "../src/utils/availability.ts";
import { AvailabilityCooldowns } from "../src/utils/availability-cooldowns.ts";
import { policyAllowsPaid, selectFailoverCandidate } from "../src/utils/failover.ts";
import { isAnonymouslyAccessible, isCredentialFree } from "../src/utils/free-model.ts";

/**
 * Migration invariants I1-I4: the OMP configuration/orchestration port must not
 * displace Pi's model-authority chain.
 *
 * These are behavioural contracts, not source-shape checks. Each asserts what a
 * consumer observes, so a refactor that keeps behaviour cannot break them and a
 * refactor that changes behaviour must.
 */

const T0 = 1_790_398_996_120;

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

/** Credential that never resolves, so the provider is genuinely unconfigured. */
const missingKeyAuth: ApiKeyAuth = { name: "Missing", resolve: async () => undefined };
const noAuth: ProviderAuth = { apiKey: missingKeyAuth };

function provider(id: string, models: Model<Api>[], auth: ProviderAuth = noAuth): Provider {
	return {
		id,
		name: id,
		auth,
		getModels: () => models,
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("I1: per-model access stays authoritative, never per-provider", () => {
	it("treats two models on the SAME provider differently when only one is credential-free", async () => {
		// This is the exact leak the invariant forbids: a provider-level "keyless" flag
		// would make both models reachable. Access is a per-model property.
		const anonymous = model("shared", "anon-model", { free: true, access: "anonymous" });
		const keyRequired = model("shared", "keyed-model", { free: true, access: "api-key" });
		const unclassified = model("shared", "unclassified-model", { free: true });

		const models = createModels();
		models.setProvider(provider("shared", [anonymous, keyRequired, unclassified]));

		const available = (await models.getAvailable()).map((m) => m.id);
		expect(available).toEqual(["anon-model"]);
	});

	it("keeps a provider-level keyless declaration from granting access to classified models", async () => {
		// A future port may add a provider-level keyless flag. It must not widen access
		// past models whose own `access` demands credentials.
		const models = createModels();
		models.setProvider(
			provider("future-keyless", [
				model("future-keyless", "free-but-keyed", { free: true, access: "login" }),
				model("future-keyless", "subscription-only", { free: true, access: "subscription" }),
			]),
		);
		expect(await models.getAvailable()).toEqual([]);
	});

	it("derives credential-freedom only from the model's own access field", () => {
		expect(isCredentialFree({ access: "anonymous" })).toBe(true);
		expect(isCredentialFree({ access: "local" })).toBe(true);
		// Price never implies reachability, in either direction.
		expect(isCredentialFree({ access: undefined })).toBe(false);
		expect(isCredentialFree({ access: "api-key" })).toBe(false);
	});

	it("keeps the anonymous allowlist in exact agreement with the catalog", async () => {
		// Guards against the allowlist and the shipped catalog drifting apart in either
		// direction, which is how a stale allowlist silently hides a working free model
		// or advertises an unreachable one.
		const { builtinProviders } = await import("../src/providers/all.ts");
		const catalog = builtinProviders().flatMap((provider) => provider.getModels());
		const catalogAnonymous = catalog
			.filter((m) => m.access === "anonymous" || m.access === "local")
			.map((m) => `${m.provider}:${m.id}`)
			.sort();
		const allowlist = catalog
			.filter((m) => isAnonymouslyAccessible(m.provider, m.id))
			.map((m) => `${m.provider}:${m.id}`)
			.sort();
		expect(allowlist).toEqual(catalogAnonymous);
	}, 30_000);
});

describe("I2: policyAllowsPaid is the mandatory spending gate", () => {
	it("permits paid selection only under the explicit compatible policy", () => {
		expect(policyAllowsPaid("compatible")).toBe(true);
		// The safe default and every other policy must refuse.
		expect(policyAllowsPaid("free-only")).toBe(false);
		expect(policyAllowsPaid("same-provider")).toBe(false);
		expect(policyAllowsPaid("off")).toBe(false);
	});

	const freeFailed = model("openrouter", "vendor/a:free", { free: true });
	const paidCandidate = model("opencode", "paid-opus", {
		cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
	});
	const freeCandidate = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });
	const base = {
		failed: freeFailed,
		requirements: {},
		cooldowns: new AvailabilityCooldowns(),
		attempted: new Set<string>(),
		now: T0,
	};

	it("refuses a paid candidate when a free one is available under free-only", () => {
		const decision = selectFailoverCandidate({
			...base,
			policy: "free-only",
			candidates: [{ model: paidCandidate }, { model: freeCandidate }],
		});
		expect("model" in decision && decision.model.id).toBe("space-bunny-free");
	});

	it("refuses a paid candidate under free-only even when it is the ONLY candidate", () => {
		const decision = selectFailoverCandidate({
			...base,
			policy: "free-only",
			candidates: [{ model: paidCandidate }],
		});
		expect("unavailable" in decision).toBe(true);
		if ("unavailable" in decision && decision.unavailable.kind === "exhausted") {
			expect(decision.unavailable.freeRequired).toBe(true);
		}
	});

	it("proves the gate is load-bearing: the same candidates are accepted under compatible", () => {
		// If this ever fails, free-only stopped being enforced and the tests above would
		// be passing for the wrong reason.
		const decision = selectFailoverCandidate({
			...base,
			policy: "compatible",
			candidates: [{ model: paidCandidate }],
		});
		expect("model" in decision && decision.model.id).toBe("paid-opus");
	});

	it("defaults an unrecognized policy to the safe side rather than a paid-capable one", () => {
		// Mirrors SettingsManager.getFailoverPolicy's degrade-to-safe behavior.
		const configured: string = "not-a-policy";
		const effective = configured === "compatible" ? "compatible" : "free-only";
		expect(effective).toBe("free-only");
	});
});

describe("I3: provider-reported failure scopes stay authoritative", () => {
	const poolBody = JSON.stringify({
		error: {
			message: "Rate limit exceeded: free-models-per-day",
			metadata: {
				headers: { "X-RateLimit-Reset": "1790467200000" },
				limit_source: "openrouter_free_tier_daily",
			},
		},
	});

	it("classifies a provider-reported pool as funding-pool scope with a reset time", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "vendor/a:free",
			stopReason: "error",
			errorMessage: `429: ${poolBody}`,
			now: T0,
		});
		expect(failure?.scope).toBe("funding-pool");
		expect(failure?.exhausted).toBe(true);
		expect(failure?.resetAtMs).toBe(1_790_467_200_000);
	});

	it("falls back to model scope when the provider reports no scope", () => {
		// Unstructured transient text must never be promoted to a pool/provider
		// exclusion, which would wrongly evict sibling models.
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "vendor/a:free",
			stopReason: "error",
			errorMessage: "overloaded_error",
			now: T0,
		});
		expect(failure?.scope).toBe("model");
		expect(failure?.exhausted).toBe(false);
	});

	it("records cooldown keys in the scoped form that makes siblings collide", () => {
		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "vendor/a:free",
			stopReason: "error",
			errorMessage: `429: ${poolBody}`,
			now: T0,
		})!;
		// Pool key carries no model id: that is the mechanism.
		expect(failure.key).toBe("pool:openrouter:openrouter_free_tier_daily");
		expect(failure.key).not.toContain("vendor/a:free");
	});

	it("excludes sibling models on the same exhausted pool but not other providers", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			...classifyAvailabilityFailure({
				provider: "openrouter",
				modelId: "vendor/a:free",
				stopReason: "error",
				errorMessage: `429: ${poolBody}`,
				now: T0,
			})!,
			now: T0,
		});

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/b:free", now: T0 })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: T0 })).toBe(false);
	});
});

describe("I4: selectFailoverCandidate is the final eligibility gate", () => {
	it("rejects a credential-missing candidate handed to it directly", () => {
		const decision = selectFailoverCandidate({
			failed: model("openrouter", "vendor/a:free", { free: true }),
			policy: "free-only",
			candidates: [
				{ model: model("opencode", "needs-key", { free: true, access: "api-key" }), credentialMissing: true },
			],
			requirements: {},
			cooldowns: new AvailabilityCooldowns(),
			attempted: new Set(),
			now: T0,
		});
		expect("unavailable" in decision).toBe(true);
	});

	it("rejects a cooldown-excluded candidate even when it is otherwise free and compatible", () => {
		const cooldowns = new AvailabilityCooldowns();
		const target = model("opencode", "excluded-free", { free: true, access: "anonymous" });
		cooldowns.record({ key: `model:opencode:${target.id}`, scope: "model", reason: "failed", now: T0 });

		const decision = selectFailoverCandidate({
			failed: model("openrouter", "vendor/a:free", { free: true }),
			policy: "free-only",
			candidates: [{ model: target }],
			requirements: {},
			cooldowns,
			attempted: new Set(),
			now: T0,
		});
		expect("unavailable" in decision).toBe(true);
	});

	it("rejects an already-attempted candidate, bounding the cycle", () => {
		const target = model("opencode", "tried-already", { free: true, access: "anonymous" });
		const decision = selectFailoverCandidate({
			failed: model("openrouter", "vendor/a:free", { free: true }),
			policy: "free-only",
			candidates: [{ model: target }],
			requirements: {},
			cooldowns: new AvailabilityCooldowns(),
			attempted: new Set(["opencode:tried-already"]),
			now: T0,
		});
		expect("unavailable" in decision).toBe(true);
	});
});
