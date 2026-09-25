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
export function withFreeFlag<M extends { id: string }>(model: M): M {
	const free = model.id.endsWith(":free") || model.id.endsWith("-free") || model.id === "openrouter/free";
	return free ? { ...model, free: true } : model;
}
