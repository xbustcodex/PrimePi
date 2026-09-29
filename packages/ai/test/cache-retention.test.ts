import { describe, expect, it } from "vitest";
import {
	autoFallbackFor,
	CACHE_RETENTION_ENV,
	describeRetention,
	resolveCacheRetention,
	retentionTtlMs,
	supportsCacheRetention,
} from "../src/utils/cache-retention.ts";

/**
 * Prompt-cache retention.
 *
 * The property that matters: **an explicit setting is never overridden by the
 * environment.** A user who chose `short` and has a stale variable set should
 * get the short writes they asked for, and the environment exists for the
 * `auto` case only.
 */

describe("an explicit setting wins", () => {
	it("is not overridden by the environment", () => {
		const resolution = resolveCacheRetention({ setting: "short", env: "long", fallback: "short" });
		expect(resolution.retention).toBe("short");
		expect(resolution.source).toBe("setting");
	});

	it("is not overridden by a hostile environment", () => {
		expect(resolveCacheRetention({ setting: "long", env: "none", fallback: "short" }).retention).toBe("long");
	});

	it("honours none, which is a choice and not an absence", () => {
		expect(resolveCacheRetention({ setting: "none", env: "long", fallback: "long" }).retention).toBe("none");
	});
});

describe("auto consults the environment, then the fallback", () => {
	it("uses a recognised environment value", () => {
		const resolution = resolveCacheRetention({ setting: "auto", env: "long", fallback: "short" });
		expect(resolution.retention).toBe("long");
		expect(resolution.source).toBe("environment");
	});

	it("names the variable, because a surprising bill is diagnosable", () => {
		// "The bill went up and nothing says why" is the failure this avoids.
		const resolution = resolveCacheRetention({ setting: "auto", env: "long", fallback: "short" });
		expect(resolution.reason).toContain(CACHE_RETENTION_ENV);
	});

	it("falls through on an unrecognised value rather than honouring it", () => {
		// A typo in a variable should not silently select a retention nobody chose,
		// and should not fail the request either.
		const resolution = resolveCacheRetention({ setting: "auto", env: "forever", fallback: "short" });
		expect(resolution.retention).toBe("short");
		expect(resolution.source).toBe("fallback");
		expect(resolution.reason).toContain("not a recognised value");
	});

	it("falls through when the variable is absent or blank", () => {
		expect(resolveCacheRetention({ setting: "auto", env: "   ", fallback: "long" }).source).toBe("fallback");
		expect(resolveCacheRetention({ setting: "auto", fallback: "long" }).retention).toBe("long");
	});

	it("trims the environment value", () => {
		expect(resolveCacheRetention({ setting: "auto", env: " long ", fallback: "short" }).retention).toBe("long");
	});
});

describe("auto means different things for different credentials", () => {
	it("prefers long for a subscriber session that supports it", () => {
		// Encoded as a provider fact rather than a preference, because the two
		// genuinely differ.
		expect(autoFallbackFor({ isOAuthSession: true, supportsLongRetention: true })).toBe("long");
	});

	it("uses short for an API-key session", () => {
		expect(autoFallbackFor({ isOAuthSession: false, supportsLongRetention: true })).toBe("short");
	});

	it("uses short when the provider cannot hold a long entry", () => {
		// Asking for a TTL the provider will ignore is worse than asking for one it
		// will honour.
		expect(autoFallbackFor({ isOAuthSession: true, supportsLongRetention: false })).toBe("short");
	});
});

describe("what reaches the wire", () => {
	it("gives each retention a TTL, and none has none", () => {
		expect(retentionTtlMs("short")).toBe(5 * 60_000);
		expect(retentionTtlMs("long")).toBe(60 * 60_000);
		// `none` is a real setting, not an absence of one.
		expect(retentionTtlMs("none")).toBeUndefined();
	});

	it("reports whether a model accepts a retention at all", () => {
		// A model that declares no support must not be sent one, whatever the user
		// asked for.
		expect(supportsCacheRetention({ cacheRetention: "short" })).toBe(true);
		expect(supportsCacheRetention({})).toBe(false);
		expect(supportsCacheRetention(undefined)).toBe(false);
	});
});

describe("the hint states the cost", () => {
	it("says long costs more to write", () => {
		expect(describeRetention("long")).toContain("pricier writes");
	});

	it("says short is cheapest and pairs with warming", () => {
		expect(describeRetention("short")).toContain("Cheapest");
	});

	it("says none disables caching entirely", () => {
		expect(describeRetention("none")).toContain("off");
	});

	it("says auto is a provider decision, not a fourth value", () => {
		expect(describeRetention("auto")).toContain("subscriber session");
	});
});
