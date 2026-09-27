import { describe, expect, it } from "vitest";
import { AvailabilityCooldowns } from "../src/utils/availability-cooldowns.ts";

/**
 * Cooldown scope matching.
 *
 * A `provider`-scoped exclusion exists to take a whole provider out of rotation
 * after an outage. It carries no model id, so it has to be matched by provider
 * identity rather than by a model-shaped key — and the key shape differs per
 * scope, which is exactly where the matching went wrong.
 *
 * `record` without a `resetAtMs` expires after the default TTL, so every query
 * here lands inside that window rather than at `now` itself.
 */

const NOW = 1_000_000;
const LATER = NOW + 1_000;

describe("provider-scoped cooldowns", () => {
	it("excludes a model on the excluded provider", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a:free", now: LATER })).toBe(true);
	});

	it("excludes every model on the excluded provider", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: NOW });

		for (const modelId of ["vendor/a:free", "vendor/b", "anthropic/claude"]) {
			expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId, now: LATER })).toBe(true);
		}
	});

	it("leaves other providers untouched", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: LATER })).toBe(
			false,
		);
	});

	it("does not match a provider whose name merely shares a prefix", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:open", scope: "provider", reason: "outage", now: NOW });

		// `opencode` is a different provider, not a longer form of `open`.
		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: LATER })).toBe(
			false,
		);
	});

	it("reports the provider scope in the reason list", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: NOW });

		const reasons = cooldowns.reasonsForModel({
			provider: "openrouter",
			modelId: "vendor/a:free",
			now: LATER,
		});
		expect(reasons).toHaveLength(1);
		expect(reasons[0]?.scope).toBe("provider");
	});

	it("stops applying once the entry expires", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "provider:openrouter", scope: "provider", reason: "outage", now: NOW });

		// Well past the default TTL.
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a", now: NOW + 120_000 })).toBe(
			false,
		);
	});
});

describe("pool-scoped cooldowns keep their funding-source boundary", () => {
	it("excludes models drawing on the same pool", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "pool:openrouter:free-tier", scope: "funding-pool", reason: "quota", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a:free", now: LATER })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/b:free", now: LATER })).toBe(true);
	});

	it("applies to every model on that provider, since the pool is shared", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "pool:openrouter:free-tier", scope: "funding-pool", reason: "quota", now: NOW });

		// Pool exclusions are deliberately coarse: the key carries no model id, which
		// is exactly what stops Pi cycling through sibling models on a spent account.
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "subscription-route", now: LATER })).toBe(
			true,
		);
	});
	it("distinguishes pools by their funding-source segment", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "pool:openrouter:free-tier", scope: "funding-pool", reason: "quota", now: NOW });

		// A different provider with a similar name must not match, and the trailing
		// separator is what stops `free-tier` from matching `free-tier-2`.
		cooldowns.record({ key: "pool:openrouter:free-tier-2", scope: "funding-pool", reason: "quota", now: NOW });

		expect(cooldowns.reasonsForModel({ provider: "openrouter", modelId: "x", now: LATER })).toHaveLength(2);
	});

	it("leaves other providers alone", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "pool:openrouter:free-tier", scope: "funding-pool", reason: "quota", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "space-bunny-free", now: LATER })).toBe(
			false,
		);
	});
});

describe("model-scoped cooldowns are unchanged", () => {
	it("excludes only the named model", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "model:openrouter:vendor/a:free", scope: "model", reason: "boom", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/a:free", now: LATER })).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/b:free", now: LATER })).toBe(
			false,
		);
	});

	it("excludes only the named provider for that model id", () => {
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "model:openrouter:vendor/a:free", scope: "model", reason: "boom", now: NOW });

		expect(cooldowns.isModelUnavailable({ provider: "opencode", modelId: "vendor/a:free", now: LATER })).toBe(false);
	});
});
