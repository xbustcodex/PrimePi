import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import {
	activeRoles,
	DEFAULT_ROLE_ALIAS,
	expandRolePatterns,
	isModelRole,
	isRoleAlias,
	MODEL_ROLE_IDS,
	MODEL_ROLES,
	resolveRoleAlias,
	resolveRoleCandidates,
} from "../src/utils/model-roles.ts";

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
const paidModel = model("opencode", "claude-opus-5", {
	cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
});
const freeModel = model("opencode", "vendor/free-model", { free: true });
const anonymous = model("opencode", "space-bunny-free", { free: true, access: "anonymous" });
const keyedFree = model("opencode", "vendor/keyed-free", { free: true, access: "api-key" });

const allKnown = new Set<string>(MODEL_ROLE_IDS);

describe("role vocabulary", () => {
	it("declares the complete OMP role set", () => {
		// Declared up front so a later consumer needs no schema migration.
		expect([...MODEL_ROLE_IDS].sort()).toEqual(
			[
				"advisor",
				"commit",
				"default",
				"dictation",
				"image",
				"judge",
				"memory",
				"plan",
				"slow",
				"smol",
				"speech",
				"task",
				"tiny",
				"vision",
				"web",
			].sort(),
		);
	});

	it("activates only roles with a real Pi consumer", () => {
		// `slow` is inactive because OMP routes it to the advisor, reviewer subagent,
		// commit agent, edit auto-repair, and skill summarisation — none of which Pi has.
		expect([...activeRoles()].sort()).toEqual(["default", "smol"]);
		for (const role of MODEL_ROLE_IDS) {
			if (MODEL_ROLES[role].activeInPi) expect(MODEL_ROLES[role].consumer).toBeTruthy();
		}
	});

	it("resolves an inactive role to no candidates", () => {
		const resolution = resolveRoleCandidates({
			role: "slow",
			configured: { slow: "anthropic/claude-opus-5" },
			available: [paidModel],
			sessionModel: freeSession,
			policy: "compatible",
		});
		expect(resolution.candidates).toEqual([]);
		expect(resolution.emptyReason).toBe("inactive-role");
	});
});

describe("alias grammar", () => {
	it("accepts bare ids, @role, pi/role, and *", () => {
		expect(resolveRoleAlias("smol", allKnown)).toBe("smol");
		expect(resolveRoleAlias("@smol", allKnown)).toBe("smol");
		expect(resolveRoleAlias("pi/smol", allKnown)).toBe("smol");
		expect(resolveRoleAlias(DEFAULT_ROLE_ALIAS, allKnown)).toBe("default");
	});

	it("rejects unknown roles and typos rather than guessing", () => {
		expect(resolveRoleAlias("@smoll", allKnown)).toBeUndefined();
		expect(resolveRoleAlias("nonexistent", allKnown)).toBeUndefined();
		expect(resolveRoleAlias("@slow-2", allKnown)).toBeUndefined();
	});

	it("rejects a role id outside the built-in vocabulary", () => {
		// Only the declared roles are resolvable; a custom name is a model pattern, not
		// a role, so it must not be mistaken for one.
		expect(resolveRoleAlias("@custom", new Set(["smol", "custom"]))).toBeUndefined();
	});

	it("identifies alias-shaped values", () => {
		expect(isRoleAlias("@smol")).toBe(true);
		expect(isRoleAlias("pi/smol")).toBe(true);
		expect(isRoleAlias("*")).toBe(true);
		expect(isRoleAlias("anthropic/claude-opus-5")).toBe(false);
	});

	it("classifies role ids", () => {
		expect(isModelRole("smol")).toBe(true);
		expect(isModelRole("nope")).toBe(false);
	});
});

describe("chain expansion", () => {
	it("uses the configured value ahead of the built-in chain", () => {
		expect(expandRolePatterns({ role: "smol", configured: { smol: "xai/grok-4.5" }, knownRoles: allKnown })).toEqual([
			"xai/grok-4.5",
		]);
	});

	it("falls back to the built-in chain when unconfigured", () => {
		const patterns = expandRolePatterns({ role: "smol", configured: {}, knownRoles: allKnown });
		expect(patterns).toEqual([...MODEL_ROLES.smol.priorityChain]);
		expect(patterns.length).toBeGreaterThan(0);
	});

	it("inherits the configured default before its own chain", () => {
		// OMP marks smol/slow as default-inheriting, so an unconfigured smol follows the
		// user's model instead of jumping to a built-in entry.
		const patterns = expandRolePatterns({
			role: "smol",
			configured: { default: "anthropic/claude-opus-5" },
			knownRoles: allKnown,
		});
		expect(patterns[0]).toBe("anthropic/claude-opus-5");
	});

	it("expands a comma list containing an alias", () => {
		const patterns = expandRolePatterns({
			role: "smol",
			configured: { smol: "@tiny, xai/grok-4.5", tiny: "qwen/qwen3.8-27b" },
			knownRoles: new Set(["smol", "tiny"]),
		});
		expect(patterns).toEqual(["qwen/qwen3.8-27b", "xai/grok-4.5"]);
	});

	it("drops an unresolvable alias instead of guessing", () => {
		const patterns = expandRolePatterns({
			role: "smol",
			configured: { smol: "@smoll, xai/grok-4.5" },
			knownRoles: allKnown,
		});
		expect(patterns).toEqual(["xai/grok-4.5"]);
	});

	it("terminates on a two-role cycle", () => {
		const patterns = expandRolePatterns({
			role: "smol",
			configured: { smol: "@slow", slow: "@smol" },
			knownRoles: allKnown,
		});
		// Bounded and finite: the cycle contributes nothing and resolution terminates.
		expect(Array.isArray(patterns)).toBe(true);
	});

	it("terminates on a self-reference and falls back to the built-in chain", () => {
		const patterns = expandRolePatterns({
			role: "smol",
			configured: { smol: "@smol" },
			knownRoles: allKnown,
		});
		// The self-reference contributes nothing, so the built-in chain applies. The
		// point is that expansion terminates rather than recursing.
		expect(patterns).toEqual([...MODEL_ROLES.smol.priorityChain]);
	});

	it("resolves a role that only aliases another role", () => {
		const patterns = expandRolePatterns({
			role: "tiny",
			configured: { tiny: "@smol", smol: "xai/grok-4.5" },
			knownRoles: new Set(["smol", "tiny"]),
		});
		expect(patterns).toEqual(["xai/grok-4.5"]);
	});
});

describe("candidate resolution: free stays free", () => {
	it("refuses a paid candidate for a free session under free-only", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/claude-opus-5" },
			available: [paidModel],
			sessionModel: freeSession,
			policy: "free-only",
		});
		expect(resolution.candidates).toEqual([]);
		expect(resolution.emptyReason).toBe("policy-blocked");
	});

	it("skips a paid chain entry and still selects a later free entry", () => {
		// The exact shape the acceptance test requires: paid first, free second.
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/claude-opus-5, opencode/vendor/free-model" },
			available: [paidModel, freeModel],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["vendor/free-model"]);
	});

	it("allows a paid candidate for a free session under the explicit compatible policy", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/claude-opus-5" },
			available: [paidModel],
			sessionModel: freeSession,
			policy: "compatible",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["claude-opus-5"]);
	});

	it("does not let the default role alias widen the free gate", () => {
		// `*` means inherit the default, never "any model".
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "*", default: "opencode/claude-opus-5" },
			available: [paidModel],
			sessionModel: freeSession,
			policy: "free-only",
		});
		expect(resolution.candidates).toEqual([]);
	});

	it("treats a paid session as not needing the free gate", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/claude-opus-5" },
			available: [paidModel],
			sessionModel: paidModel,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["claude-opus-5"]);
	});
});

describe("candidate resolution: access and credentials", () => {
	it("keeps an anonymous credential-free model eligible", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/space-bunny-free" },
			available: [anonymous],
			sessionModel: freeSession,
			policy: "free-only",
			// No credential at all, and the model is still eligible.
			credentialMissing: () => true,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["space-bunny-free"]);
	});

	it("excludes a credential-required free model when credentials are missing", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/vendor/keyed-free" },
			available: [keyedFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => true,
		});
		expect(resolution.candidates).toEqual([]);
		expect(resolution.emptyReason).toBe("no-credential");
	});

	it("includes a credential-required free model when credentials exist", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/vendor/keyed-free" },
			available: [keyedFree],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["vendor/keyed-free"]);
	});

	it("assumes credentials are missing when the caller cannot tell", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/vendor/keyed-free" },
			available: [keyedFree],
			sessionModel: freeSession,
			policy: "free-only",
		});
		expect(resolution.candidates).toEqual([]);
	});
});

describe("candidate resolution: matching and ordering", () => {
	it("matches a bare id pattern and prefers the most specific qualifier", () => {
		const a = model("openrouter", "haiku-4-5", { free: true });
		const b = model("anthropic", "haiku-4-5", { free: true });
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "anthropic/haiku-4-5, haiku-4-5" },
			available: [a, b],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => `${m.provider}:${m.id}`)).toEqual([
			"anthropic:haiku-4-5",
			"openrouter:haiku-4-5",
		]);
	});

	it("deduplicates a model reachable through two patterns", () => {
		const only = model("openrouter", "vendor/thing:free", { free: true });
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "vendor/thing:free, openrouter/vendor/thing:free" },
			available: [only],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.candidates).toHaveLength(1);
	});

	it("matches an Ollama-style tag suffix", () => {
		const tagged = model("ollama", "qwen2.5-coder:7b");
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "qwen2.5-coder" },
			available: [tagged],
			sessionModel: freeSession,
			policy: "compatible",
			credentialMissing: () => false,
		});
		expect(resolution.candidates.map((m) => m.id)).toEqual(["qwen2.5-coder:7b"]);
	});

	it("reports no-match when nothing in the available set fits", () => {
		const resolution = resolveRoleCandidates({
			role: "smol",
			configured: { smol: "opencode/claude-opus-5" },
			available: [freeModel],
			sessionModel: freeSession,
			policy: "free-only",
			credentialMissing: () => false,
		});
		expect(resolution.emptyReason).toBe("no-match");
	});

	it("returns unresolved for an active role with no chain and no configuration", () => {
		const resolution = resolveRoleCandidates({
			role: "default",
			configured: {},
			available: [freeModel],
			sessionModel: freeSession,
			policy: "free-only",
		});
		expect(resolution.candidates).toEqual([]);
		expect(resolution.emptyReason).toBe("unresolved");
	});
});
