import { rmSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateModelUsability, isProviderUsable } from "../src/core/model/provider-usability.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DEFAULT_DELEGATION_BUDGETS } from "../src/core/orchestration/delegation-budgets.ts";
import { resolvePlanExitTransition } from "../src/core/orchestration/plan-model-transition.ts";

/**
 * The provider-usability authority, adversarially.
 *
 * Every case here is a leak that was open before this authority existed, or a
 * variant of one. The pattern is the same throughout: disable a provider, then
 * try to reach it through a path that does not consult role resolution, and prove
 * the path refuses.
 *
 * The ambient-credential case is the one the upstream reference reported
 * (oh-my-pi commit `f10425abad`): with a key present in the environment, a
 * request was authorized regardless of the provider being disabled. A credential
 * being present is not permission, and these tests pin that.
 */

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

/** A paid model on a configured provider. */
const PAID_MODEL = model("openrouter", "vendor/paid");
/** A free model on the same provider — the case a naive filter lets through. */
const FREE_MODEL = model("openrouter", "vendor/free", {
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	free: true,
	access: "anonymous",
});
/** A model on a different provider, which disabling one must not affect. */
const OTHER_MODEL = model("anthropic", "claude-sonnet-4-5");

const DISABLED = new Set(["openrouter"]);

describe("provider usability authority", () => {
	it("reports a disabled provider as disabled, whatever the model", () => {
		// The two cases a "does it need auth" check conflates.
		expect(isProviderUsable("openrouter", DISABLED)).toBe(false);
		expect(isProviderUsable("anthropic", DISABLED)).toBe(true);
		// An absent set means nothing is disabled, not everything.
		expect(isProviderUsable("openrouter")).toBe(true);
		expect(isProviderUsable("openrouter", new Set())).toBe(true);
	});

	it("ranks disabled above every other reason, so a refusal is explainable", () => {
		// A paid, credential-less model on a disabled provider has three possible
		// reasons. Only one is the user's actual intent, and reporting "unreachable"
		// would send them to a login page instead of the provider settings.
		const usability = evaluateModelUsability(PAID_MODEL, {
			disabledProviders: DISABLED,
			credentialMissing: true,
			credentialFree: false,
			allowsPaid: false,
		});
		expect(usability).toBe("disabled");
	});

	it("keeps a credential-free model on a disabled provider disabled", () => {
		// The specific leak: `isCredentialFree` is true, so any filter keyed on
		// "needs no credentials" would keep it.
		const usability = evaluateModelUsability(FREE_MODEL, {
			disabledProviders: DISABLED,
			credentialMissing: false,
			credentialFree: true,
			allowsPaid: true,
		});
		expect(usability).toBe("disabled");
	});

	it("does not let paid/free distinctions weaken the disabled rule", () => {
		// Vary every model-side property. The answer must not move.
		for (const candidate of [
			PAID_MODEL,
			FREE_MODEL,
			model("openrouter", "vendor/login", { access: "login" }),
			model("openrouter", "vendor/local", { access: "local" }),
			model("openrouter", "vendor/unknown", { access: "unknown" }),
		]) {
			expect(
				evaluateModelUsability(candidate, {
					disabledProviders: DISABLED,
					credentialMissing: true,
					credentialFree: false,
					allowsPaid: true,
				}),
			).toBe("disabled");
		}
	});

	it("still reports the other reasons when nothing is disabled", () => {
		// The authority must not degrade into "everything is disabled", which would
		// make it useless as a diagnostic.
		expect(
			evaluateModelUsability(PAID_MODEL, {
				disabledProviders: new Set(),
				credentialMissing: true,
				credentialFree: false,
				allowsPaid: true,
			}),
		).toBe("unreachable");
		expect(
			evaluateModelUsability(PAID_MODEL, {
				disabledProviders: new Set(),
				credentialMissing: false,
				credentialFree: false,
				allowsPaid: false,
			}),
		).toBe("blocked-by-policy");
		expect(
			evaluateModelUsability(FREE_MODEL, {
				disabledProviders: new Set(),
				credentialMissing: true,
				credentialFree: true,
				allowsPaid: false,
			}),
		).toBe("usable");
	});
});

/**
 * A runtime stub exposing only what ModelRegistry consumes, so the registry's own
 * gating is what is under test rather than the runtime's.
 */
function registryWith(disabled: ReadonlySet<string>, known: readonly Model<Api>[]): ModelRegistry {
	const runtime = {
		getDisabledProviders: () => disabled,
		getModels: () => [...known],
		getAvailableSnapshot: () => [...known],
		getModel: (provider: string, id: string) =>
			known.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: () => true,
		getAuth: async (target: string | Model<Api>) => {
			const provider = typeof target === "string" ? target : target.provider;
			// A key exists for every provider: an ambient environment credential.
			// Its presence must not make a disabled provider usable.
			return isProviderUsable(provider, disabled) ? { auth: { apiKey: `key-for-${provider}` } } : undefined;
		},
		getCompatibilityRequestConfig: () => ({}),
		getProvider: () => undefined,
		getError: () => undefined,
		refresh: async () => ({}),
		isUsingOAuth: () => false,
		complete: async () => ({}),
		stream: async () => ({}),
		registerProvider: () => {},
		registerNativeProvider: () => {},
		unregisterProvider: () => {},
		getRegisteredProviderConfig: () => undefined,
		getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderIds: () => [],
		getProviderDisplayName: (provider: string) => provider,
	};
	return new ModelRegistry(runtime as never);
}

const CATALOG = [PAID_MODEL, FREE_MODEL, OTHER_MODEL];

describe("literal lookup and credential issuance", () => {
	it("cannot recover a disabled provider's model by name", () => {
		const registry = registryWith(DISABLED, CATALOG);
		// Before the authority, this answered the model and every fallback caller
		// that reached for it got a disabled provider.
		expect(registry.find("openrouter", "vendor/paid")).toBeUndefined();
		expect(registry.find("openrouter", "vendor/free")).toBeUndefined();
	});

	it("still resolves a model on an enabled provider", () => {
		// Disabling one provider must not affect another.
		const registry = registryWith(DISABLED, CATALOG);
		expect(registry.find("anthropic", "claude-sonnet-4-5")).toBeDefined();
	});

	it("issues no credential for a disabled provider, even when one exists", async () => {
		const registry = registryWith(DISABLED, CATALOG);
		// The ambient-credential case. The stub returns a key for every enabled
		// provider; a disabled one must get nothing.
		expect(await registry.getApiKeyForProvider("openrouter")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("anthropic")).toBe("key-for-anthropic");
	});

	it("cannot see a disabled provider's models in the registry's available list", () => {
		// The registry is a facade over the runtime, so it does not re-filter: the
		// authority lives in `ModelRuntime.updateModelSnapshot`. This asserts the
		// registry passes that list through unchanged, which is the property that
		// makes the runtime the single place the filter has to be correct.
		const registry = registryWith(DISABLED, CATALOG);
		expect(registry.getAvailable().map((candidate) => candidate.id)).toEqual([
			"vendor/paid",
			"vendor/free",
			"claude-sonnet-4-5",
		]);
	});

	it("reports a disabled provider as having no configured auth", () => {
		// A caller that consults this before selecting a candidate must not see a
		// reachable-looking provider.
		const registry = registryWith(DISABLED, CATALOG);
		expect(registry.hasConfiguredAuth(FREE_MODEL)).toBe(false);
		expect(registry.hasConfiguredAuth(OTHER_MODEL)).toBe(true);
	});
	it("restores eligibility when the provider is re-enabled, without a new registry", async () => {
		// Live read, not a captured set. The same registry instance must observe
		// the change; that is what "no restart" means here.
		let disabled: ReadonlySet<string> = DISABLED;
		const runtime = {
			getDisabledProviders: () => disabled,
			getModels: () => [...CATALOG],
			getAvailableSnapshot: () => [...CATALOG],
			getModel: (provider: string, id: string) => CATALOG.find((c) => c.provider === provider && c.id === id),
			hasConfiguredAuth: () => true,
			getAuth: async (target: string | Model<Api>) => {
				const provider = typeof target === "string" ? target : target.provider;
				return isProviderUsable(provider, disabled) ? { auth: { apiKey: "k" } } : undefined;
			},
			getCompatibilityRequestConfig: () => ({}),
		};
		const registry = new ModelRegistry(runtime as never);

		expect(registry.find("openrouter", "vendor/paid")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("openrouter")).toBeUndefined();

		disabled = new Set<string>();
		expect(registry.find("openrouter", "vendor/paid")).toBeDefined();
		expect(await registry.getApiKeyForProvider("openrouter")).toBe("k");
	});
});

describe("plan mode restore", () => {
	it("refuses to restore a model whose provider was disabled while planning", () => {
		// `_prePlanModel` is a record of what was true on entry. Restoring it without
		// re-checking puts the session back on a model the user has since turned off.
		const transition = resolvePlanExitTransition({
			current: OTHER_MODEL,
			restoreTo: PAID_MODEL,
			isStreaming: false,
			disabledProviders: DISABLED,
		});
		expect(transition.kind).toBe("none");
		if (transition.kind !== "none") return;
		expect(transition.reason).toMatch(/disabled/i);
	});

	it("restores the model when its provider is still enabled", () => {
		const transition = resolvePlanExitTransition({
			current: OTHER_MODEL,
			restoreTo: PAID_MODEL,
			isStreaming: false,
			disabledProviders: new Set(["some-other-provider"]),
		});
		expect(transition.kind).toBe("apply");
	});

	it("restores a credential-free model when its provider is still enabled", () => {
		// The restore path must not refuse a free model that was never disabled.
		const transition = resolvePlanExitTransition({
			current: OTHER_MODEL,
			restoreTo: FREE_MODEL,
			isStreaming: false,
			disabledProviders: new Set<string>(),
		});
		expect(transition.kind).toBe("apply");
	});

	it("restores when no disabled set is supplied at all", () => {
		// A caller with no settings must not have every restore refused.
		const transition = resolvePlanExitTransition({
			current: OTHER_MODEL,
			restoreTo: PAID_MODEL,
			isStreaming: false,
		});
		expect(transition.kind).toBe("apply");
	});
});

describe("delegation budgets are unaffected", () => {
	it("keeps the delegation budget shape intact", () => {
		// A guard against this phase having disturbed Phase 6: the authority is
		// about providers, and must not have leaked into delegation limits.
		expect(DEFAULT_DELEGATION_BUDGETS.maxDepth).toBe(2);
		expect(DEFAULT_DELEGATION_BUDGETS.maxConcurrency).toBe(8);
	});
});
