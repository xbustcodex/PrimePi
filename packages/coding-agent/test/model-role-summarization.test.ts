import {
	type Api,
	AvailabilityCooldowns,
	type Model,
	resolveRoleCandidates,
	selectFailoverCandidate,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Integration coverage for the `smol` role as consumed by summarisation.
 *
 * The role layer proposes candidates; it never establishes usability. These tests
 * assert the composed behaviour: role expansion, then the final eligibility gate,
 * with the paid-first / free-second shape the acceptance criteria call for.
 */

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...extra,
	};
}

const freeSession = model("openrouter", "vendor/a:free", { free: true });
const paidCandidate = model("opencode", "claude-opus-5", {
	cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
});
const anonymousFree = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });
const keyedFree = model("opencode", "vendor/keyed-free", { free: true, access: "api-key" });

/**
 * Mirrors the selection the summarisation consumer performs: resolve the role, then
 * hand each candidate to the final gate in role order.
 */
function selectForSummarization(input: {
	configured: Record<string, string>;
	available: readonly Model<Api>[];
	sessionModel: Model<Api>;
	policy: "off" | "same-provider" | "free-only" | "compatible";
	credentialMissing: (provider: string) => boolean;
	cooldowns?: AvailabilityCooldowns;
}): Model<Api> {
	const cooldowns = input.cooldowns ?? new AvailabilityCooldowns();
	const resolution = resolveRoleCandidates({
		role: "smol",
		configured: input.configured,
		available: input.available,
		sessionModel: input.sessionModel,
		policy: input.policy,
		credentialMissing: input.credentialMissing,
	});
	if (resolution.candidates.length === 0) return input.sessionModel;
	for (const candidate of resolution.candidates) {
		const decision = selectFailoverCandidate({
			failed: input.sessionModel,
			policy: input.policy,
			candidates: [{ model: candidate }],
			requirements: {},
			cooldowns,
			attempted: new Set<string>(),
			now: Date.now(),
		});
		if ("model" in decision) return decision.model;
	}
	return input.sessionModel;
}

describe("smol role for summarisation", () => {
	it("rejects a paid chain entry and selects the compatible free entry", () => {
		const selected = selectForSummarization({
			// Paid first, free second: exactly the acceptance shape.
			configured: { smol: "opencode/claude-opus-5, opencode/space-bunny-free" },
			available: [paidCandidate, anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected.id).toBe("space-bunny-free");
		expect(selected.free).toBe(true);
	});

	it("falls back to the session model when the role is unconfigured", () => {
		const selected = selectForSummarization({
			configured: {},
			available: [anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected).toBe(freeSession);
	});

	it("falls back when the role names a model that does not exist", () => {
		const selected = selectForSummarization({
			configured: { smol: "opencode/does-not-exist" },
			available: [anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected).toBe(freeSession);
	});

	it("falls back when the configured value is an unresolvable alias", () => {
		const selected = selectForSummarization({
			configured: { smol: "@nonexistent" },
			available: [anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected).toBe(freeSession);
	});

	it("falls back when the only candidate needs absent credentials", () => {
		const selected = selectForSummarization({
			configured: { smol: "opencode/vendor/keyed-free" },
			available: [keyedFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected).toBe(freeSession);
	});

	it("falls back when the only candidate is unavailable on cooldown", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			key: `model:opencode:${anonymousFree.id}`,
			scope: "model",
			reason: "failed",
			now: Date.now(),
		});
		const selected = selectForSummarization({
			configured: { smol: "opencode/space-bunny-free" },
			available: [anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
			cooldowns,
		});
		// The role proposes it, but the final gate refuses, so the session model stands.
		expect(selected).toBe(freeSession);
	});

	it("falls back when the policy is off", () => {
		const selected = selectForSummarization({
			configured: { smol: "opencode/space-bunny-free" },
			available: [anonymousFree],
			sessionModel: freeSession,
			policy: "off",
			credentialMissing: () => true,
		});
		expect(selected).toBe(freeSession);
	});

	it("selects a paid candidate only under the explicit compatible policy", () => {
		const selected = selectForSummarization({
			configured: { smol: "opencode/claude-opus-5" },
			available: [paidCandidate],
			sessionModel: freeSession,
			policy: "compatible",
			credentialMissing: () => false,
		});
		expect(selected.id).toBe("claude-opus-5");
	});

	it("selects the inherited default when the role delegates to it", () => {
		const defaultModel = model("opencode", "vendor/default-free", { free: true, access: "anonymous" });
		const selected = selectForSummarization({
			configured: { smol: "@default", default: "opencode/vendor/default-free" },
			available: [defaultModel, anonymousFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(selected.id).toBe("vendor/default-free");
	});
});

describe("modelRoles settings round-trip", () => {
	it("reads an empty map when unconfigured", () => {
		expect(SettingsManager.inMemory().getModelRoles()).toEqual({});
	});

	it("round-trips a role assignment through the registry", () => {
		const manager = SettingsManager.inMemory();
		manager.setModelRole("smol", "@tiny, xai/grok-4.5");
		expect(manager.getModelRoles()).toEqual({ smol: "@tiny, xai/grok-4.5" });
	});

	it("clears a role when set to undefined", () => {
		const manager = SettingsManager.inMemory();
		manager.setModelRole("smol", "xai/grok-4.5");
		manager.setModelRole("smol", undefined);
		expect(manager.getModelRoles()).toEqual({});
	});

	it("rejects a malformed modelRoles value", () => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setSetting("modelRoles", "not-a-map", "global")).toThrow(/modelRoles/);
		expect(() => manager.setSetting("modelRoles", { smol: 42 }, "global")).toThrow(/modelRoles/);
	});

	it("does not hand out a mutable reference to the merged view", () => {
		const manager = SettingsManager.inMemory();
		manager.setModelRole("smol", "xai/grok-4.5");
		const roles = manager.getModelRoles();
		roles.smol = "mutated";
		expect(manager.getModelRoles().smol).toBe("xai/grok-4.5");
	});

	it("exposes modelRoles as config-only, never as a settings control", async () => {
		const { lookupSetting, uiSettings } = await import("../src/core/settings-registry.ts");
		const descriptor = lookupSetting("modelRoles");
		expect(descriptor).toBeDefined();
		// No `ui` block, so it cannot become a dead control.
		expect(descriptor?.descriptor.ui).toBeUndefined();
		expect(uiSettings().some((row) => row.id === "modelRoles")).toBe(false);
	});
});
