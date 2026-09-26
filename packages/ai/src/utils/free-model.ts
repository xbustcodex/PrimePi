import type { ModelAccess } from "../types.ts";

/**
 * Free-tier models carry an explicit upstream id suffix: OpenRouter `:free`,
 * OpenCode Zen/Go `-free`. Plus OpenRouter's `openrouter/free` router, which
 * only selects free models. Never derive this from zero cost - routers and
 * promos also report 0.
 *
 * Shared by the model generator (scripts/generate-models.ts) and the runtime
 * OpenCode catalog refresh (providers/opencode-refresh.ts) so both sides flag
 * the same models.
 */
export function withFreeFlag<M extends { id: string }>(model: M): M & { free?: true } {
	const free = model.id.endsWith(":free") || model.id.endsWith("-free") || model.id === "openrouter/free";
	return free ? { ...model, free: true } : model;
}

/**
 * Free models that are served **without credentials**.
 *
 * This is a model-level property, not a provider-level one: OpenCode Zen serves
 * `space-bunny-free` anonymously while its other `-free` models answer
 * `403 FreeTierError: "OpenCode's free tier can only be used from within
 * OpenCode"`, and `opencode-go` answers `401 Missing API key` for the same id.
 * Classifying the whole provider as anonymous would advertise unreachable
 * models; classifying it as credentialed would hide the one that works.
 *
 * Membership is `provider:id` because ids are only unique per provider. Each
 * entry was confirmed with a single `max_tokens=1` request carrying no
 * `Authorization` header; anything not listed stays unclassified and therefore
 * requires the provider's normal credentials.
 */
const ANONYMOUS_FREE_MODELS = new Set(["opencode:space-bunny-free"]);

/** True when this exact model is known to be reachable with no credentials. */
export function isAnonymouslyAccessible(provider: string, id: string): boolean {
	return ANONYMOUS_FREE_MODELS.has(`${provider}:${id}`);
}

/**
 * Attaches an explicit `access` value for models that are reachable without
 * credentials, leaving every other model unclassified so the existing
 * provider-credential requirement still governs it.
 */
export function withAccessFlag<M extends { id: string; provider: string }>(model: M): M & { access?: ModelAccess } {
	if (!isAnonymouslyAccessible(model.provider, model.id)) return model;
	return { ...model, access: "anonymous" satisfies ModelAccess };
}

/**
 * True when the model can be called without the provider's credentials, either
 * because it is served anonymously or because it runs locally.
 *
 * This is a reachability question, not a price question. It is deliberately not
 * derived from `free`: a `:free` model that answers `401 Missing API key` is
 * free and still unreachable.
 */
export function isCredentialFree(model: { access?: ModelAccess }): boolean {
	return model.access === "anonymous" || model.access === "local";
}

/**
 * True when a provider can be reached at all without credentials, i.e. it offers at
 * least one model that needs none. Used to decide whether an unauthenticated
 * provider contributes any models to the available set.
 */
export function hasCredentialFreeModels(models: readonly { access?: ModelAccess }[]): boolean {
	return models.some(isCredentialFree);
}
