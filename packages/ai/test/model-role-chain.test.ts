import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { AvailabilityCooldowns } from "../src/utils/availability-cooldowns.ts";
import { policyAllowsPaid, selectFailoverCandidate } from "../src/utils/failover.ts";
import { type RoleChainCandidate, resolveRoleChain, splitThinkingSuffix } from "../src/utils/model-roles.ts";

/**
 * Role chains: proposal, ordering, and the boundary against selection.
 *
 * The recurring assertion in this file is that a chain can only ever *propose*.
 * Configuration may name, prefer, and order a model as strongly as it likes; the
 * eligibility filters still run, and `selectFailoverCandidate` still decides.
 *
 * Every call passes `credentialMissing` explicitly. The chain fails closed when
 * that probe is absent — it cannot tell whether a credential exists, so it
 * excludes rather than guesses.
 */

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		api: "anthropic-messages",
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

const paidModel = model("anthropic", "claude-opus-5", {
	cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
});
const freeModel = model("openrouter", "vendor/a:free", { free: true });
const keyedFree = model("openrouter", "vendor/keyed-free", { free: true, access: "api-key" });
const anonymous = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });

/** Every provider has a credential. */
const hasCredentials = () => false;
/** Only openrouter lacks one. */
const openrouterMissing = (provider: string) => provider === "openrouter";

function ids(candidates: RoleChainCandidate[]): string[] {
	return candidates.map((candidate) => `${candidate.model.provider}/${candidate.model.id}`);
}

function reasons(rejected: readonly { reason: string }[]): string[] {
	return rejected.map((entry) => entry.reason);
}

describe("chain expansion and ordering", () => {
	it("orders candidates by the configured preference list", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free, opencode/space-bunny-free" },
			available: [anonymous, freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(ids(result.candidates)).toEqual(["openrouter/vendor/a:free", "opencode/space-bunny-free"]);
	});

	it("applies a configured fallback list in place of the built-in chain", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: {},
			fallbackChains: { smol: ["opencode/space-bunny-free"] },
			available: [freeModel, anonymous],
			eligibility: { credentialMissing: hasCredentials },
		});

		// The built-in chain would have surfaced the openrouter model first.
		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
	});

	it("treats an empty configured fallback list as no fallbacks", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: {},
			fallbackChains: { smol: [] },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
		expect(result.patterns).toEqual([]);
	});

	it("marks configuration-derived candidates explicit", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(result.candidates[0]?.explicit).toBe(true);
		expect(result.candidates[0]?.fromFallback).toBe(false);
	});

	it("marks fallback-derived candidates as fromFallback", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: {},
			fallbackChains: { smol: ["openrouter/vendor/a:free"] },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(result.candidates[0]?.fromFallback).toBe(true);
	});

	it("expands a role alias in a fallback list", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { tiny: "opencode/space-bunny-free" },
			fallbackChains: { smol: ["@tiny"] },
			available: [freeModel, anonymous],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
	});

	it("stays bounded when two roles reference each other", () => {
		// `smol` and `tiny` both name each other. Expansion must terminate rather
		// than recurse forever.
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "@tiny", tiny: "@smol" },
			fallbackChains: { smol: ["@tiny", "@smol", "@tiny"] },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(Array.isArray(result.candidates)).toBe(true);
	});

	it("drops a self-referencing fallback instead of looping", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "@smol" },
			fallbackChains: { smol: ["@smol"] },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
	});
});

describe("eligibility: hard constraints", () => {
	it("removes a disabled provider", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
		expect(reasons(result.rejected)).toContain("disabled-provider");
	});

	it("removes a provider disabled even when reached through a fallback", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: {},
			fallbackChains: { smol: ["openrouter/vendor/a:free"] },
			available: [freeModel],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
	});

	it("removes a model outside a non-empty allowlist", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free, opencode/space-bunny-free" },
			available: [freeModel, anonymous],
			eligibility: { enabledModelPatterns: ["opencode/*"], credentialMissing: hasCredentials },
		});

		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
		expect(reasons(result.rejected)).toContain("not-allowlisted");
	});

	it("treats an empty allowlist as no allowlist", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { enabledModelPatterns: [], credentialMissing: hasCredentials },
		});

		expect(ids(result.candidates)).toEqual(["openrouter/vendor/a:free"]);
	});

	it("removes a paid candidate when the session is free and the policy forbids paid", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "anthropic/claude-opus-5" },
			available: [paidModel],
			eligibility: { sessionModel: freeModel, policy: "free-only", credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
		expect(reasons(result.rejected)).toContain("policy-paid");
	});

	it("keeps a paid candidate when the policy allows paid", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "anthropic/claude-opus-5" },
			available: [paidModel],
			eligibility: { sessionModel: freeModel, policy: "compatible", credentialMissing: hasCredentials },
		});

		expect(ids(result.candidates)).toEqual(["anthropic/claude-opus-5"]);
	});

	it("removes a model whose provider credential is missing", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/keyed-free" },
			available: [keyedFree],
			eligibility: { credentialMissing: openrouterMissing },
		});

		expect(result.candidates).toEqual([]);
		expect(reasons(result.rejected)).toContain("missing-credential");
	});

	it("keeps an anonymous model when no provider has a credential", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free" },
			available: [anonymous],
			// Every provider reports a missing credential; the anonymous model must
			// still be reachable, because it needs none.
			eligibility: { credentialMissing: () => true },
		});

		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
	});

	it("fails closed when no credential probe is supplied", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
		});

		expect(result.candidates).toEqual([]);
		expect(reasons(result.rejected)).toContain("missing-credential");
	});

	it("reports a disabled provider as disabled rather than as missing credentials", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: () => true },
		});

		expect(result.rejected[0]?.reason).toBe("disabled-provider");
	});

	it("resolves nothing for a role with no Pi consumer", () => {
		const result = resolveRoleChain({
			role: "slow",
			configured: { slow: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		expect(result.candidates).toEqual([]);
	});
});

describe("preference: ranking only after eligibility", () => {
	it("promotes a preferred provider among candidates", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free, openrouter/vendor/a:free" },
			available: [freeModel, anonymous],
			eligibility: { credentialMissing: hasCredentials },
			preferences: { providerOrder: ["openrouter", "opencode"] },
		});

		expect(ids(result.candidates)).toEqual(["openrouter/vendor/a:free", "opencode/space-bunny-free"]);
	});

	it("never ranks a disabled provider back into the list", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free, openrouter/vendor/a:free" },
			available: [freeModel, anonymous],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: hasCredentials },
			// The most-preferred provider is precisely the disabled one.
			preferences: { providerOrder: ["openrouter", "opencode"] },
		});

		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
		expect(reasons(result.rejected)).toContain("disabled-provider");
	});

	it("never ranks a credential-missing model back into the list", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/keyed-free, opencode/space-bunny-free" },
			available: [keyedFree, anonymous],
			eligibility: { credentialMissing: openrouterMissing },
			preferences: { providerOrder: ["openrouter", "opencode"] },
		});

		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
		expect(reasons(result.rejected)).toContain("missing-credential");
	});

	it("never ranks a paid model into a free-only session", () => {
		const result = resolveRoleChain({
			role: "smol",
			configured: { smol: "anthropic/claude-opus-5, openrouter/vendor/a:free" },
			available: [paidModel, freeModel],
			eligibility: { sessionModel: freeModel, policy: "free-only", credentialMissing: hasCredentials },
			preferences: { providerOrder: ["anthropic", "openrouter"] },
		});

		expect(ids(result.candidates)).toEqual(["openrouter/vendor/a:free"]);
		expect(reasons(result.rejected)).toContain("policy-paid");
	});

	it("keeps eligibility and preference as separate inputs at the call site", () => {
		const withoutPreference = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free, openrouter/vendor/a:free" },
			available: [freeModel, anonymous],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: hasCredentials },
		});
		const withPreference = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free, openrouter/vendor/a:free" },
			available: [freeModel, anonymous],
			eligibility: { disabledProviders: new Set(["openrouter"]), credentialMissing: hasCredentials },
			preferences: { providerOrder: ["openrouter", "opencode"] },
		});

		// Preference changes ordering; it cannot change membership.
		expect(withPreference.candidates).toEqual(withoutPreference.candidates);
	});
});

describe("cooldown scopes", () => {
	it("blocks a model-scoped cooldown at selection time", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			key: "model:openrouter:vendor/a:free",
			scope: "model",
			reason: "hard failure",
			now: 1_000_000,
		});

		const decision = selectFailoverCandidate({
			failed: anonymous,
			policy: "compatible",
			candidates: [{ model: freeModel }],
			requirements: { requiresTools: false },
			cooldowns,
			attempted: new Set<string>(),
			now: 1_000_000 + 1_000,
		});

		expect(decision).toEqual({
			unavailable: {
				kind: "exhausted",
				considered: 1,
				freeRequired: false,
				blocked: [expect.stringContaining("unavailable (model)")],
			},
		});
	});

	it("blocks a provider-scoped cooldown that covers a sibling model", () => {
		const cooldowns = new AvailabilityCooldowns();
		// Without a provider reset the entry lives for the default TTL, so the
		// query has to land inside that window rather than at `now` itself.
		const later = 1_000_000 + 1_000;
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: 1_000_000 });

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a:free", now: later })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: later })).toBe(
			false,
		);
	});
	it("blocks a funding-pool cooldown that covers every sibling model", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			key: "pool:openrouter:free-tier",
			scope: "funding-pool",
			reason: "quota exhausted",
			now: 1_000_000,
		});
		const later = 1_000_000 + 1_000;

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a:free", now: later })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/other", now: later })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: later })).toBe(
			false,
		);
	});
});

describe("thinking suffixes", () => {
	it("splits a level off a role alias", () => {
		expect(splitThinkingSuffix("@smol:high")).toEqual({
			pattern: "@smol",
			thinking: { level: "high", source: "@smol:high" },
		});
	});

	it("splits a level off a provider-qualified selector", () => {
		expect(splitThinkingSuffix("openrouter/vendor/a:free:low")).toEqual({
			pattern: "openrouter/vendor/a:free",
			thinking: { level: "low", source: "openrouter/vendor/a:free:low" },
		});
	});

	it("drops an unsupported level deterministically and keeps the selector intact", () => {
		// `ultra` is not a Pi thinking level. The suffix must not become part of the
		// model id, and no level may be invented.
		const parsed = splitThinkingSuffix("@smol:ultra");
		expect(parsed.thinking.level).toBeUndefined();
		expect(parsed.pattern).toBe("@smol:ultra");
	});

	it("attaches the level to the candidate without changing eligibility", () => {
		const withLevel = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free:high" },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});
		const withoutLevel = resolveRoleChain({
			role: "smol",
			configured: { smol: "openrouter/vendor/a:free" },
			available: [freeModel],
			eligibility: { credentialMissing: hasCredentials },
		});

		// Identical membership: the level is metadata, not a filter.
		expect(ids(withLevel.candidates)).toEqual(ids(withoutLevel.candidates));
		expect(withLevel.candidates[0]?.thinking.level).toBe("high");
		expect(withoutLevel.candidates[0]?.thinking.level).toBeUndefined();
	});

	it("leaves a selector without a suffix untouched", () => {
		expect(splitThinkingSuffix("openrouter/vendor/a:free")).toEqual({
			pattern: "openrouter/vendor/a:free",
			thinking: {},
		});
	});

	it("does not treat a tag colon as a thinking suffix", () => {
		// A bare id may legitimately carry a `:` tag, which is part of the id.
		expect(splitThinkingSuffix("llama3:8b")).toEqual({ pattern: "llama3:8b", thinking: {} });
	});
});

describe("adversarial: configuration cannot force an ineligible model", () => {
	it("ignores a config that prefers paid, credential-missing, and cooled-down models", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:anthropic", scope: "provider", reason: "outage", now: 1_000_000 });

		const result = resolveRoleChain({
			role: "smol",
			// Configuration screams for three ineligible models, in order.
			configured: { smol: "anthropic/claude-opus-5, openrouter/vendor/keyed-free, openrouter/vendor/a:free" },
			fallbackChains: { smol: ["anthropic/claude-opus-5", "openrouter/vendor/keyed-free"] },
			available: [paidModel, keyedFree, freeModel, anonymous],
			eligibility: {
				sessionModel: freeModel,
				policy: "free-only",
				credentialMissing: openrouterMissing,
			},
			// And ranks the worst offender first.
			preferences: { providerOrder: ["anthropic", "openrouter", "opencode"] },
		});

		// Every model the configuration asked for is rejected, so the chain is empty.
		// The anonymous model is present in the pool but no pattern names it, so it
		// is correctly absent: a chain proposes what it was told, nothing more.
		expect(result.candidates).toEqual([]);

		// The rejections are recorded, so nothing fails silently.
		const collected = reasons(result.rejected);
		expect(collected).toContain("policy-paid");
		expect(collected).toContain("missing-credential");

		// The provider-scoped cooldown would additionally block anthropic at
		// selection time even if policy had allowed it.
		expect(
			cooldowns.isModelUnavailable({ provider: "anthropic", modelId: "claude-opus-5", now: 1_000_000 + 1_000 }),
		).toBe(true);
	});

	it("falls through to a reachable model when the preferred ones are ineligible", () => {
		const result = resolveRoleChain({
			role: "smol",
			// The first two choices are ineligible; only the third is reachable.
			configured: { smol: "anthropic/claude-opus-5, openrouter/vendor/keyed-free, opencode/space-bunny-free" },
			available: [paidModel, keyedFree, anonymous],
			eligibility: {
				sessionModel: freeModel,
				policy: "free-only",
				credentialMissing: openrouterMissing,
			},
			preferences: { providerOrder: ["anthropic", "openrouter", "opencode"] },
		});

		// Only the model that cleared every gate is proposed, even though it ranks
		// last by preference. Preference cannot manufacture eligibility.
		expect(ids(result.candidates)).toEqual(["opencode/space-bunny-free"]);
		expect(reasons(result.rejected)).toContain("policy-paid");
		expect(reasons(result.rejected)).toContain("missing-credential");
	});

	it("keeps the final selector authoritative over a chain's first entry", () => {
		const chain = resolveRoleChain({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free" },
			available: [anonymous],
			eligibility: { credentialMissing: hasCredentials },
		});

		const decision = selectFailoverCandidate({
			// The only candidate the chain offers is also the failed model.
			failed: anonymous,
			policy: "free-only",
			candidates: chain.candidates.map((candidate: RoleChainCandidate) => ({ model: candidate.model })),
			requirements: { requiresTools: false },
			cooldowns: new AvailabilityCooldowns(),
			attempted: new Set<string>(),
			now: 1_000_000,
		});

		expect(decision).toEqual({
			unavailable: { kind: "exhausted", considered: 0, freeRequired: true, blocked: [] },
		});
	});

	it("never lets a chain make a session spend under a paid-forbidding policy", () => {
		expect(policyAllowsPaid("free-only")).toBe(false);
		expect(policyAllowsPaid("off")).toBe(false);
		expect(policyAllowsPaid("same-provider")).toBe(false);
		expect(policyAllowsPaid("compatible")).toBe(true);
	});
});
