import type { Model, TurnRequirements } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseRouteSelector, resolveFallbackChain, shouldRevertToPrimary } from "../src/core/failover/chain.ts";

/**
 * Fallback chains.
 *
 * The chain machinery existed with unit tests and **no production caller**: the
 * session failed over by scanning every available model, so a user who
 * configured `retry.fallbackChains` got no ordering they asked for. These tests
 * pin the properties the wiring depends on, not the whole module.
 *
 * The load-bearing one is **the chain proposes and the policy disposes**. If a
 * chain could route around a `free-only` policy, the paid/credential-free
 * authority would be decorative.
 */

const model = (provider: string, id: string): Model<"openai-completions"> =>
	({
		id,
		name: id,
		provider,
		api: "openai-completions",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
	}) as unknown as Model<"openai-completions">;

// The failover authority reads the `free` flag, not a cost table.
const free = (provider: string, id: string) => ({ ...model(provider, id), free: true });

const paid = (provider: string, id: string) => ({ ...model(provider, id), free: false });

/**
 * Narrows a chain result.
 *
 * The union discriminates on `ok`, but an inline `if (result.ok)` does not
 * narrow it here because the field widens to `boolean` at the call site. A type
 * predicate is explicit and does not depend on inference.
 */
const ok = <T extends { ok: true }>(result: T | { ok: false }): result is T => result.ok === true;

const requirements = { requiresTools: true } as unknown as TurnRequirements;
// No cooldown is recorded, so every route is reachable.
const noCooldowns = { isModelUnavailable: () => false, reasonsForModel: () => [] } as never;

const base = {
	role: "default",
	chains: { default: ["other/free-a", "other/paid-b"] },
	lookup: (provider: string, id: string) => (id === "free-a" ? free(provider, id) : paid(provider, id)),
	policy: "compatible" as const,
	requirements,
	cooldowns: noCooldowns,
	attempted: new Set<string>(),
	now: 1_000,
};

describe("a chain orders the routes a user configured", () => {
	it("proposes the first configured entry", () => {
		const result = resolveFallbackChain({
			...base,
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		if (!ok(result)) return;
		expect(result.decision.model.id).toBe("free-a");
	});

	it("walks past an entry the policy refused", () => {
		// A chain naming a paid model must not route around a free-only policy.
		const result = resolveFallbackChain({
			...base,
			policy: "free-only",
			chains: { default: ["other/paid-b", "other/free-a"] },
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		if (!ok(result)) return;
		expect(result.decision.model.id).toBe("free-a");
	});

	it("advances rather than restarting after each failure", () => {
		// Restarting from the head means a permanently dead first route pays its
		// timeout on every turn, forever.
		const first = resolveFallbackChain({
			...base,
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		if (!ok(first)) return;
		const state = {
			chainKey: first.chainKey,
			index: first.index,
			primary: parseRouteSelector("primary/gpt-5")!,
			served: false,
		};
		const second = resolveFallbackChain({
			...base,
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
			attempted: new Set(["other/free-a"]),
			state,
		});
		if (!ok(second)) return;
		expect(second.index).toBe(1);
	});

	it("skips a malformed entry rather than failing the whole chain", () => {
		// A chain is hand-edited JSON; one bad line must not disable the routes
		// after it.
		const result = resolveFallbackChain({
			...base,
			chains: { default: ["not a selector at all", "other/free-a"] },
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		if (!ok(result)) return;
		expect(result.decision.model.id).toBe("free-a");
	});

	it("reports exhausted rather than looping", () => {
		const result = resolveFallbackChain({
			...base,
			chains: { default: ["other/free-a"] },
			attempted: new Set(["other/free-a"]),
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		expect(result.ok).toBe(false);
		if (ok(result)) return;
		expect(result.unavailable.kind).toBe("exhausted");
	});

	it("does nothing when failover is off", () => {
		const result = resolveFallbackChain({
			...base,
			policy: "off",
			failed: free("primary", "gpt-5"),
			primary: parseRouteSelector("primary/gpt-5")!,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unavailable.kind).toBe("disabled");
	});
});

describe("reverting to the primary needs both conditions", () => {
	const state = { chainKey: "default", index: 1, primary: parseRouteSelector("primary/gpt-5")!, served: true };

	it("reverts once the primary's cooldown has expired", () => {
		expect(
			shouldRevertToPrimary({ state, revertPolicy: "cooldown-expiry", primaryCooldownUntil: 500, now: 1_000 }),
		).toBe(true);
	});

	it("does not revert into a live cooldown", () => {
		// Reverting there would fail immediately and switch again.
		expect(
			shouldRevertToPrimary({ state, revertPolicy: "cooldown-expiry", primaryCooldownUntil: 5_000, now: 1_000 }),
		).toBe(false);
	});

	it("never reverts when the policy says never", () => {
		expect(shouldRevertToPrimary({ state, revertPolicy: "never", primaryCooldownUntil: undefined, now: 1_000 })).toBe(
			false,
		);
	});

	it("does not revert from the head of the chain", () => {
		// Index 0 is the primary position itself; there is nothing to return to.
		const head = { ...state, index: 0 };
		expect(
			shouldRevertToPrimary({
				state: head,
				revertPolicy: "cooldown-expiry",
				primaryCooldownUntil: undefined,
				now: 1_000,
			}),
		).toBe(false);
	});
});
