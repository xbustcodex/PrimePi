/**
 * OpenRouter routing variants: the `:suffix` on a wire model id.
 *
 * ## What the suffix is
 *
 * OpenRouter fronts many upstream providers for one model id. A routing variant
 * narrows or widrows which of them may serve the request — `:floor` prefers the
 * cheapest, `:nitro` the fastest, `:exacto` a curated set. It travels in the
 * model id itself, not in a header, so it is the last thing decided before the
 * body is serialized.
 *
 * ## Why a default is not a variant
 *
 * `"default"` is a *setting* value, not a wire value. Sending `:default` would
 * be a different request from sending nothing, and OpenRouter has no such
 * variant. The setting therefore normalizes to `undefined` before it reaches
 * this module, and {@link applyOpenRouterRoutingVariant} treats any falsy input
 * as "send the id unchanged".
 *
 * ## An explicit suffix always wins
 *
 * A variant counts as already present when the id holds a colon after its last
 * `/`. That covers both a user-typed selector (`anthropic/claude-haiku:nitro`)
 * and a catalog id that bakes one in (`deepseek/deepseek-v3.1-terminus:exacto`),
 * including a thinking suffix after it (`:exacto:high`). Appending a second
 * variant there would ask for something the endpoint cannot parse, so the
 * setting stays out of it entirely.
 */

/** Appends a routing variant to an OpenRouter model id that does not name one. */
export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
}

/**
 * The wire model id for a request.
 *
 * The variant applies only to OpenRouter. Every other endpoint — including an
 * OpenAI-compatible gateway that happens to proxy OpenRouter — would reject a
 * suffixed id, so the caller gates on the host rather than trusting the setting
 * to be paired correctly with the model.
 */
export function resolveOpenRouterWireModelId(input: {
	readonly modelId: string;
	readonly provider: string;
	readonly baseUrl: string;
	readonly variant: string | undefined;
}): string {
	const isOpenRouter = input.provider === "openrouter" || input.baseUrl.includes("openrouter.ai");
	if (!isOpenRouter) return input.modelId;
	return applyOpenRouterRoutingVariant(input.modelId, input.variant);
}
