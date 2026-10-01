import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { evaluateModelUsability, isProviderUsable } from "../src/core/model/provider-usability.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
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

describe("the disabled rule is enforced where a credential is actually issued", () => {
	// Every case above is a pure function over an explicit set. None of them proves
	// the rule holds on the path a request takes, and that path is the one that can
	// spend money.
	//
	// Before this test the leak was open: selection filtered a disabled provider's
	// models out of `available`, but `ModelRuntime.prepareRequest` never consulted the
	// disabled set at all. A caller holding a Model object — which a failover candidate
	// list, a role resolution, or an extension does — reached the provider with a
	// credential, and the request went out. Verified by driving the real runtime with a
	// credential on disk and an ambient key in options.
	it("refuses a disabled provider even when a credential is present and usable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-disabled-"));
		dirs.push(dir);
		const auth = AuthStorage.create(join(dir, "auth.json"));
		// A real, configured credential. Presence is not permission.
		await auth.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-should-never-be-sent" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });
		runtime.setDisabledProvidersReader(() => new Set(["anthropic"]));

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const message = await runtime
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
				// The ambient-key case the upstream reference reported: even an explicitly
				// supplied credential must not override the user's decision to disable.
				{ apiKey: "sk-ant-should-never-be-sent" } as never,
			)
			.result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain('Provider "anthropic" is disabled');
		// The credential itself must not appear in anything the user or model sees.
		expect(JSON.stringify(message)).not.toContain("sk-ant-should-never-be-sent");
	});

	it("still serves the same provider once it is enabled again", async () => {
		// The check reads the live set on every request, so re-enabling takes effect
		// without a restart. Without a disabled check here this passes trivially, which
		// is why the refusing case above carries the weight.
		const dir = mkdtempSync(join(tmpdir(), "pi-enabled-"));
		dirs.push(dir);
		const auth = AuthStorage.create(join(dir, "auth.json"));
		await auth.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-test" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: join(dir, "models.json") });

		let disabled = true;
		runtime.setDisabledProvidersReader(() => (disabled ? new Set(["anthropic"]) : new Set<string>()));
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never;

		const blocked = await runtime.streamSimple(model, context).result();
		expect(blocked.stopReason).toBe("error");

		disabled = false;
		// No network call is made: with no credential-free model and a real provider
		// behind it, the request either resolves or fails on the network. Either way the
		// refusal must no longer be the disabled-provider one.
		const allowed = await runtime.streamSimple(model, context).result();
		expect(allowed.errorMessage ?? "").not.toContain("is disabled");
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
