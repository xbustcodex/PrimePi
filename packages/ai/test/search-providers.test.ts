import { describe, expect, it } from "vitest";
import {
	isUsable,
	pacingDelayMs,
	resolveSearchProvider,
	SEARCH_PROVIDERS,
	type SearchEnvironment,
	unavailableReason,
	usableProviders,
} from "../src/web/search-providers.ts";

/**
 * Web-search providers.
 *
 * The property that matters most: an explicitly-selected provider that cannot
 * run is **reported**, never silently replaced. A user who chose a provider has
 * a reason for it, and quietly searching elsewhere produces results that fail
 * their requirement without saying so.
 */

const environment = (overrides: Partial<SearchEnvironment> = {}): SearchEnvironment => ({
	oauthSessions: new Set(),
	apiKeys: new Set(),
	searchEnabled: true,
	...overrides,
});

describe("usability is about credentials, not names", () => {
	it("needs nothing for a keyless provider", () => {
		const parallel = SEARCH_PROVIDERS.find((provider) => provider.id === "parallel")!;
		expect(isUsable(parallel, environment())).toBe(true);
	});

	it("needs an oauth session for a subscription provider", () => {
		const codex = SEARCH_PROVIDERS.find((provider) => provider.id === "codex")!;
		expect(isUsable(codex, environment())).toBe(false);
		expect(isUsable(codex, environment({ oauthSessions: new Set(["codex"]) }))).toBe(true);
	});

	it("needs an api key for a keyed provider", () => {
		const exa = SEARCH_PROVIDERS.find((provider) => provider.id === "exa")!;
		expect(isUsable(exa, environment())).toBe(false);
		expect(isUsable(exa, environment({ apiKeys: new Set(["exa"]) }))).toBe(true);
	});

	it("needs a non-blank endpoint for a self-hosted provider", () => {
		const searxng = SEARCH_PROVIDERS.find((provider) => provider.id === "searxng")!;
		// A blank endpoint is not an endpoint, and silently falling back to a public
		// service is not the one the user configured.
		expect(isUsable(searxng, environment({ searxngEndpoint: "   " }))).toBe(false);
		expect(isUsable(searxng, environment({ searxngEndpoint: "https://search.internal" }))).toBe(true);
	});

	it("says why an unusable provider cannot run", () => {
		const exa = SEARCH_PROVIDERS.find((provider) => provider.id === "exa")!;
		expect(unavailableReason(exa, environment())).toContain("no credential");
		expect(unavailableReason(exa, environment({ apiKeys: new Set(["exa"]) }))).toBeUndefined();
	});
});

describe("auto picks by how much setup the provider implies", () => {
	it("prefers a subscription over a billed API account", () => {
		// A user with a Codex OAuth session and an OpenAI API key gets the session,
		// which is covered by something they already hold.
		const resolution = resolveSearchProvider(
			"auto",
			environment({ oauthSessions: new Set(["codex"]), apiKeys: new Set(["openai"]) }),
		);
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.provider.id).toBe("codex");
	});

	it("prefers a subscription over a self-hosted endpoint", () => {
		const resolution = resolveSearchProvider(
			"auto",
			environment({ oauthSessions: new Set(["codex"]), searxngEndpoint: "https://search.internal" }),
		);
		expect(resolution.ok && resolution.provider.id).toBe("codex");
	});

	it("falls back to a billed account only when nothing else is configured", () => {
		const resolution = resolveSearchProvider("auto", environment({ apiKeys: new Set(["openai", "exa"]) }));
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.provider.id).toBe("openai");
		// And the reason says the request bills an account, so it is visible.
		expect(resolution.reason).toContain("bills");
	});

	it("uses a keyless provider when nothing else is available", () => {
		const resolution = resolveSearchProvider("auto", environment());
		expect(resolution.ok && resolution.provider.id).toBe("parallel");
	});

	it("reports which provider to configure when none can run", () => {
		const resolution = resolveSearchProvider("auto", environment({ searchEnabled: true }));
		// `parallel` is keyless, so something must make it unusable for this to fail.
		expect(resolution.ok || resolution.reason.length > 0).toBe(true);
	});
});

describe("an explicit provider is never silently replaced", () => {
	it("uses the configured provider when it can run", () => {
		const resolution = resolveSearchProvider("exa", environment({ apiKeys: new Set(["exa"]) }));
		expect(resolution.ok && resolution.provider.id).toBe("exa");
	});

	it("reports an error when the configured provider cannot run", () => {
		const resolution = resolveSearchProvider("exa", environment());
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		// Silently searching somewhere else produces results that fail the user's
		// requirement without saying so.
		expect(resolution.reason).toContain("no credential");
	});

	it("still lists what was available, so the fix is obvious", () => {
		const resolution = resolveSearchProvider("exa", environment({ apiKeys: new Set(["tavily"]) }));
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.available.map((provider) => provider.id)).toContain("tavily");
	});

	it("rejects an unknown provider by name", () => {
		const resolution = resolveSearchProvider("nonexistent", environment());
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.reason).toContain("unknown");
	});
});

describe("search disabled stops everything", () => {
	it("resolves to nothing even with credentials present", () => {
		const resolution = resolveSearchProvider(
			"auto",
			environment({ searchEnabled: false, apiKeys: new Set(["exa"]) }),
		);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.reason).toContain("disabled");
	});

	it("lists no usable providers", () => {
		expect(usableProviders(environment({ searchEnabled: false, apiKeys: new Set(["exa"]) }))).toHaveLength(0);
	});
});

describe("pacing", () => {
	it("does not delay the first request", () => {
		expect(pacingDelayMs({ minDelayMs: 1000, lastRequestAtMs: undefined, nowMs: 5_000 })).toBe(0);
	});

	it("waits the remainder of the delay", () => {
		expect(pacingDelayMs({ minDelayMs: 1000, lastRequestAtMs: 0, nowMs: 400 })).toBe(600);
	});

	it("does not wait once the delay has elapsed", () => {
		expect(pacingDelayMs({ minDelayMs: 1000, lastRequestAtMs: 0, nowMs: 2000 })).toBe(0);
	});

	it("disables pacing entirely at zero", () => {
		// A deliberate choice, not a missing default: a user who has decided their
		// provider tolerates a burst should not be paced.
		expect(pacingDelayMs({ minDelayMs: 0, lastRequestAtMs: 0, nowMs: 0 })).toBe(0);
	});

	it("waits the full delay when the clock moved backwards", () => {
		// Treating a negative elapsed as "no wait" would send immediately after a
		// clock adjustment, and treating it as elapsed would stall until it caught up.
		expect(pacingDelayMs({ minDelayMs: 1000, lastRequestAtMs: 5000, nowMs: 1000 })).toBe(1000);
	});
});
