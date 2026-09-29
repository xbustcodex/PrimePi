/**
 * Prompt-cache retention: how long a cache entry a request writes survives.
 *
 * ## Why this is a real setting and not an optimisation
 *
 * A longer retention means cheaper reads and a **more expensive write**. The
 * write is paid on every request whose prefix changed, so a session that edits
 * one line early and then sends twenty messages pays the long-TTL write price
 * every time while getting almost none of the benefit.
 *
 * That trade is why `long` is not the default, and why the setting says
 * explicitly what it costs rather than presenting retention as a free upgrade.
 *
 * ## Three user values, three wire values
 *
 * `auto` is not a fourth retention. It means "let the provider and the
 * environment decide", which is different from picking one, and it resolves
 * before any value reaches the wire.
 *
 * ## Precedence is explicit, and the environment is a deliberate second
 *
 * 1. **The setting**, when the user has chosen one.
 * 2. **The environment variable**, when the setting is `auto` and the variable
 *    holds a recognised value.
 * 3. **The fallback**, supplied by the caller.
 *
 * An unrecognised environment value falls through rather than being honoured:
 * a typo in a variable should not silently select a retention nobody chose, and
 * it should not fail a request either.
 *
 * ## The OAuth distinction is a provider fact, not a preference
 *
 * A subscriber session and an API-key session have different cache economics at
 * the provider, and the reference encodes that as the `auto` fallback rather
 * than as a user choice. So `auto` means different things for different
 * credentials, and that difference is passed in rather than re-derived here.
 */

import type { CacheRetention } from "../types.ts";

/** What the user selects. */
export type CacheRetentionSetting = "auto" | CacheRetention;

export interface RetentionResolution {
	/** The value to send. `none` disables caching entirely. */
	readonly retention: CacheRetention;
	/** Where the value came from, so a surprising bill is diagnosable. */
	readonly source: "setting" | "environment" | "fallback";
	readonly reason: string;
}

/** The environment variable, named so a reader does not have to grep for it. */
export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

/**
 * Resolves retention.
 *
 * The environment is consulted only when the user chose `auto`, so an explicit
 * short or long is never overridden by an environment a user forgot was set.
 */
export function resolveCacheRetention(input: {
	readonly setting: CacheRetentionSetting;
	readonly env?: string | undefined;
	/** The caller's default, which already accounts for the credential type. */
	readonly fallback: CacheRetention;
}): RetentionResolution {
	if (input.setting !== "auto") {
		return {
			retention: input.setting,
			source: "setting",
			reason: `retention chosen in settings: ${input.setting}`,
		};
	}
	const env = input.env?.trim();
	if (env === "long" || env === "short" || env === "none") {
		return {
			retention: env,
			source: "environment",
			// Named, because "the bill went up and nothing says why" is the failure.
			reason: `auto resolved from ${CACHE_RETENTION_ENV}=${env}`,
		};
	}
	return {
		retention: input.fallback,
		source: "fallback",
		reason:
			input.env && input.env.trim().length > 0
				? `auto fell through: ${CACHE_RETENTION_ENV}=${input.env} is not a recognised value`
				: `auto fell through to the provider default: ${input.fallback}`,
	};
}

/** The TTL a retention buys, where the provider expresses one. */
export function retentionTtlMs(retention: CacheRetention): number | undefined {
	switch (retention) {
		case "none":
			return undefined;
		case "short":
			return 5 * 60_000;
		case "long":
			return 60 * 60_000;
	}
}

/**
 * The fallback for a credential type.
 *
 * Encoded as a fact about the provider rather than a user preference, because
 * a subscriber session and an API-key session genuinely differ: `auto` means
 * different things for the two.
 */
export function autoFallbackFor(options: {
	readonly isOAuthSession: boolean;
	readonly supportsLongRetention: boolean;
}): CacheRetention {
	// A provider that cannot hold a long entry gets the short one rather than a
	// request asking for a TTL it will ignore.
	if (!options.supportsLongRetention) return "short";
	return options.isOAuthSession ? "long" : "short";
}

/** Whether a provider accepts a retention at all. */
export function supportsCacheRetention(model: { cacheRetention?: CacheRetention } | undefined): boolean {
	// A model that declares no retention support must not be sent one, whatever the
	// user asked for.
	return model?.cacheRetention !== undefined;
}

/** One line for a settings hint, naming the cost. */
export function describeRetention(setting: CacheRetentionSetting): string {
	switch (setting) {
		case "none":
			return "Prompt caching is off. Every request is sent in full and nothing is reused.";
		case "short":
			return "Cheapest cache writes. Pair with cache warming to keep entries alive while idle.";
		case "long":
			return "One-hour entries: pricier writes, warmed only during active runs.";
		case "auto":
			return "The provider decides: a subscriber session defaults to one hour, an API key to five minutes.";
	}
}
