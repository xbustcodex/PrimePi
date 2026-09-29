/**
 * Web-search providers: what each one needs, and which can actually run here.
 *
 * ## Why a capability table rather than a list of names
 *
 * A search provider is usable or not depending on a credential, an OAuth
 * session, or a self-hosted endpoint. Listing names and asking the caller to
 * remember which is which is how a session ends up selecting a provider that
 * cannot run and reporting "search failed" instead of "not configured".
 *
 * So each provider declares what it needs, and {@link resolveSearchProvider}
 * answers two questions separately: *which can run here*, and *which did we pick*.
 *
 * ## `auto` is a real choice, not a fallback
 *
 * `auto` picks the first configured provider **in the declared order**, which
 * is ordered by how much setup the provider implies — OAuth sessions and API
 * keys before self-hosted endpoints before nothing at all. A user with a Codex
 * OAuth session and a SearXNG instance gets the OAuth session, which is the one
 * that is billed under a subscription they already hold.
 *
 * ## The distinction that matters for cost
 *
 * A provider is marked `billedToAccount` when its usage lands on an API account
 * the user pays for, and false when it is keyless, self-hosted, or covered by an
 * existing subscription. That is *not* a routing decision — a keyless provider
 * that is rate-limited is still the wrong choice over one that would cost money
 * — but it is the difference a user needs to see before a search costs them
 * something, and it is reported rather than assumed.
 */

/** What a provider needs before it can run. */
export type SearchCredential =
	/** Nothing: a public or keyless endpoint. */
	| "none"
	/** An OAuth session obtained through a login flow. */
	| "oauth"
	/** An API key from settings or the environment. */
	| "api-key"
	/** A self-hosted endpoint the user supplies. */
	| "self-hosted";

/** One search provider and what it needs. */
export interface SearchProvider {
	readonly id: string;
	readonly label: string;
	readonly credential: SearchCredential;
	/** Where the credential comes from, for a settings hint. */
	readonly credentialHint: string;
	/**
	 * True when usage is billed to a paid API account.
	 *
	 * Reported, never used to bypass a rate limit. A keyless provider that is
	 * rate-limited is still preferable to one that costs money.
	 */
	readonly billedToAccount: boolean;
	/** Lower runs first under `auto`. */
	readonly priority: number;
}

/**
 * The registry, ordered by how much setup the provider implies.
 *
 * OAuth sessions and API keys come first: they are what a user with an existing
 * subscription has, and using one costs nothing extra. Self-hosted endpoints
 * follow. Keyless public endpoints come last because they are the most likely
 * to be rate-limited and the least likely to be what the user wanted.
 */
export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
	{
		id: "codex",
		label: "OpenAI Codex",
		credential: "oauth",
		credentialHint: "ChatGPT OAuth via /login openai-codex",
		billedToAccount: false,
		priority: 10,
	},
	{
		id: "anthropic",
		label: "Anthropic",
		credential: "oauth",
		credentialHint: "Anthropic OAuth or ANTHROPIC_API_KEY",
		billedToAccount: false,
		priority: 11,
	},
	{
		id: "gemini",
		label: "Gemini",
		credential: "oauth",
		credentialHint: "google-gemini-cli or google-antigravity OAuth",
		billedToAccount: false,
		priority: 12,
	},
	{
		id: "xai",
		label: "xAI",
		credential: "oauth",
		credentialHint: "SuperGrok/X Premium+ OAuth or XAI_API_KEY",
		billedToAccount: false,
		priority: 13,
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		credential: "api-key",
		credentialHint: "the selected model's configured credentials",
		billedToAccount: false,
		priority: 14,
	},
	// Billed to a separate API account: the user pays per request here, and it is
	// kept below the subscription-backed providers for exactly that reason.
	{
		id: "openai",
		label: "OpenAI API",
		credential: "api-key",
		credentialHint: "OPENAI_API_KEY, separate from ChatGPT OAuth",
		billedToAccount: true,
		priority: 30,
	},
	{
		id: "perplexity",
		label: "Perplexity",
		credential: "api-key",
		credentialHint: "PERPLEXITY_API_KEY",
		billedToAccount: true,
		priority: 31,
	},
	{
		id: "exa",
		label: "Exa",
		credential: "api-key",
		credentialHint: "EXA_API_KEY",
		billedToAccount: true,
		priority: 32,
	},
	{
		id: "tavily",
		label: "Tavily",
		credential: "api-key",
		credentialHint: "TAVILY_API_KEY",
		billedToAccount: true,
		priority: 33,
	},
	{
		id: "kagi",
		label: "Kagi",
		credential: "api-key",
		credentialHint: "KAGI_API_KEY and Search API beta access",
		billedToAccount: true,
		priority: 34,
	},
	{
		id: "jina",
		label: "Jina",
		credential: "api-key",
		credentialHint: "JINA_API_KEY",
		billedToAccount: true,
		priority: 35,
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		credential: "api-key",
		credentialHint: "FIRECRAWL_API_KEY; falls back to keyless mode",
		billedToAccount: true,
		priority: 36,
	},
	{
		id: "brave",
		label: "Brave",
		credential: "api-key",
		credentialHint: "BRAVE_API_KEY",
		billedToAccount: true,
		priority: 37,
	},
	{
		id: "searxng",
		label: "SearXNG",
		credential: "self-hosted",
		credentialHint: "a self-hosted SearXNG endpoint",
		billedToAccount: false,
		priority: 20,
	},
	{
		id: "parallel",
		label: "Parallel",
		credential: "none",
		credentialHint: "the keyless public MCP",
		billedToAccount: false,
		priority: 50,
	},
];

/** What the environment and settings can supply. */
export interface SearchEnvironment {
	/** OAuth sessions present, by provider id. */
	readonly oauthSessions: ReadonlySet<string>;
	/** API keys present, by provider id. */
	readonly apiKeys: ReadonlySet<string>;
	/** A self-hosted endpoint, for `searxng`. */
	readonly searxngEndpoint?: string;
	/** Whether search itself is enabled. */
	readonly searchEnabled: boolean;
}

/** Whether a provider can actually run with what is present. */
export function isUsable(provider: SearchProvider, environment: SearchEnvironment): boolean {
	switch (provider.credential) {
		case "none":
			return true;
		case "oauth":
			return environment.oauthSessions.has(provider.id);
		case "api-key":
			return environment.apiKeys.has(provider.id);
		case "self-hosted":
			// A blank endpoint is not an endpoint, and a provider that silently falls
			// back to a public service is not the one the user configured.
			return (environment.searxngEndpoint ?? "").trim().length > 0;
	}
}

/** Providers that can run, in `auto` order. */
export function usableProviders(environment: SearchEnvironment): SearchProvider[] {
	if (!environment.searchEnabled) return [];
	return SEARCH_PROVIDERS.filter((provider) => isUsable(provider, environment)).sort(
		(left, right) => left.priority - right.priority,
	);
}

/** Why a provider could not run, for a settings hint. */
export function unavailableReason(provider: SearchProvider, environment: SearchEnvironment): string | undefined {
	if (isUsable(provider, environment)) return undefined;
	switch (provider.credential) {
		case "none":
			return undefined;
		case "oauth":
			return `not signed in; ${provider.credentialHint}`;
		case "api-key":
			return `no credential; ${provider.credentialHint}`;
		case "self-hosted":
			return "no endpoint configured";
	}
}

export type SearchResolution =
	| { readonly ok: true; readonly provider: SearchProvider; readonly reason: string }
	| { readonly ok: false; readonly reason: string; readonly available: readonly SearchProvider[] };

/**
 * Resolves which provider to use.
 *
 * An explicit provider that cannot run is reported as an **error**, not
 * silently replaced. A user who selected a provider has a reason for it —
 * coverage, latency, cost — and quietly searching somewhere else produces
 * results that fail their requirement without saying so.
 */
export function resolveSearchProvider(requested: string, environment: SearchEnvironment): SearchResolution {
	const available = usableProviders(environment);
	if (!environment.searchEnabled) {
		return { ok: false, reason: "web search is disabled", available };
	}
	if (requested !== "auto") {
		const provider = SEARCH_PROVIDERS.find((candidate) => candidate.id === requested);
		if (!provider) return { ok: false, reason: `unknown search provider: ${requested}`, available };
		if (!isUsable(provider, environment)) {
			return { ok: false, reason: unavailableReason(provider, environment) ?? "not usable", available };
		}
		return { ok: true, provider, reason: "the configured provider" };
	}
	const first = available[0];
	if (!first) {
		// Every provider needs something this environment does not have. Saying
		// which is the difference between a fixable setup and a dead end.
		const firstNeed = SEARCH_PROVIDERS.find((provider) => !isUsable(provider, environment));
		return {
			ok: false,
			reason: firstNeed
				? `no search provider is configured; ${firstNeed.label} needs ${firstNeed.credentialHint}`
				: "no search provider is configured",
			available,
		};
	}
	// Ordered by how much setup the provider implies, so a subscription the user
	// already holds is used before one that bills them.
	const reason = first.billedToAccount
		? "the first configured provider, which bills an API account"
		: "the first configured provider";
	return { ok: true, provider: first, reason };
}

/**
 * The delay before a request, given the last one.
 *
 * Pacing a rate-limited provider does not prevent the limit; it keeps a burst
 * from converting a momentary allowance into a sustained block. `0` disables
 * pacing entirely, which is a deliberate choice and not a missing default.
 */
export function pacingDelayMs(input: {
	readonly minDelayMs: number;
	readonly lastRequestAtMs: number | undefined;
	readonly nowMs: number;
}): number {
	if (input.minDelayMs <= 0) return 0;
	if (input.lastRequestAtMs === undefined) return 0;
	const elapsed = input.nowMs - input.lastRequestAtMs;
	// A negative elapsed means the clock moved backwards; treating it as "wait the
	// full delay" would stall until it catches up.
	if (elapsed < 0) return input.minDelayMs;
	return Math.max(0, input.minDelayMs - elapsed);
}
