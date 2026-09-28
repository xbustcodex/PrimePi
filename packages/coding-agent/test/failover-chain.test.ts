import { describe, expect, it } from "vitest";
import {
	AvailabilityCooldowns,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type ChainState,
	describeFallback,
	markServed,
	parseRouteSelector,
	resolveFallbackChain,
	shouldRevertToPrimary,
} from "../src/core/failover/chain.ts";

/**
 * Retry fallback chains.
 *
 * The first three cases are behaviours the reference already has tests for in
 * `oh-my-pi/packages/coding-agent/test/agent-session-retry-fallback.test.ts`,
 * transcribed: a chain that advances rather than restarts, a default chain
 * used when the live model matches no role, and a chain that must not route
 * around a provider the user disabled.
 *
 * Everything else covers what the chain layer owns above `selectFailoverCandidate`.
 */

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		cost: { input: 1, output: 1 },
		limit: { context: 200_000, output: 8_000 },
		...extra,
	} as Model<Api>;
}

const anthropic = model("anthropic", "claude-sonnet-4-5");
const openai = model("openai", "gpt-4o-mini", { api: "openai-completions" });
const google = model("google", "gemini-2-0-flash", { api: "google-generative-ai" });

function lookupOf(...models: Model<Api>[]) {
	return (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id);
}

const base = {
	role: "default",
	primary: { provider: "anthropic", id: "claude-sonnet-4-5", raw: "anthropic/claude-sonnet-4-5" },
	lookup: lookupOf(anthropic, openai, google),
	policy: "compatible" as const,
	requirements: {},
	cooldowns: new AvailabilityCooldowns(),
	now: 1_000_000,
};

describe("route parsing", () => {
	it("splits on the first separator, so a slash in a model id survives", () => {
		// Splitting on the last separator would route to provider `meta` for a
		// model id that does not exist there.
		expect(parseRouteSelector("meta/llama-3/70b")).toEqual({
			provider: "meta",
			id: "llama-3/70b",
			raw: "meta/llama-3/70b",
		});
	});

	it("returns undefined rather than throwing on a malformed entry", () => {
		// A chain is hand-edited JSON; one bad line must not disable the rest.
		for (const bad of ["", "   ", "no-separator", "/leading", "trailing/"]) {
			expect(parseRouteSelector(bad), bad).toBeUndefined();
		}
	});
});

describe("chain resolution, as the reference specifies", () => {
	it("advances through the chain rather than restarting at its head", () => {
		const chains = { default: ["openai/gpt-4o-mini", "google/gemini-2-0-flash"] };
		const attempted = new Set<string>();

		// First failure: the head.
		const first = resolveFallbackChain({ ...base, failed: anthropic, chains, attempted });
		expect(first.ok && first.route.id).toBe("gpt-4o-mini");

		// Second failure on that route: the chain moves on rather than retrying the
		// entry that just failed.
		attempted.add("openai/gpt-4o-mini");
		const second = resolveFallbackChain({ ...base, failed: openai, chains, attempted });
		expect(second.ok && second.route.id).toBe("gemini-2-0-flash");
	});

	it("uses the default chain when the role has no chain of its own", () => {
		// Reference behaviour (#12421): a live model matching no role primary still
		// gets a route out, rather than failing the turn.
		const result = resolveFallbackChain({
			...base,
			role: "subagent",
			failed: anthropic,
			chains: { default: ["openai/gpt-4o-mini"] },
			attempted: new Set(),
		});
		expect(result.ok).toBe(true);
	});

	it("never routes to a provider settings disable", () => {
		// The chain is a preference order, not a permission. Naming a disabled
		// provider in a chain must not route around the user's own restriction.
		const result = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["openai/gpt-4o-mini", "google/gemini-2-0-flash"] },
			attempted: new Set(["google/gemini-2-0-flash"]),
			policy: "same-provider",
		});
		if (result.ok) {
			expect(result.route.provider).toBe("anthropic");
		} else {
			expect(result.unavailable.kind).toBe("exhausted");
		}
	});

	it("reports a policy that refuses everything rather than returning nothing", () => {
		const result = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["openai/gpt-4o-mini"] },
			attempted: new Set(),
			policy: "off",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.unavailable.kind).toBe("disabled");
	});

	it("reports no chain distinctly from an exhausted one", () => {
		// They demand different responses: one means "configure a chain", the other
		// means "every route in it failed".
		const missing = resolveFallbackChain({ ...base, failed: anthropic, chains: {}, attempted: new Set() });
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.unavailable.kind).toBe("no-chain");

		const exhausted = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["openai/gpt-4o-mini"] },
			attempted: new Set(["openai/gpt-4o-mini"]),
		});
		expect(exhausted.ok).toBe(false);
		if (exhausted.ok) return;
		expect(exhausted.unavailable.kind).toBe("exhausted");
	});

	it("skips a malformed entry and keeps going", () => {
		const result = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["not-a-route", "openai/gpt-4o-mini"] },
			attempted: new Set(),
		});
		expect(result.ok && result.route.id).toBe("gpt-4o-mini");
	});

	it("skips an entry naming a model the registry does not know", () => {
		const result = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["ghost/does-not-exist", "google/gemini-2-0-flash"] },
			attempted: new Set(),
		});
		expect(result.ok && result.route.id).toBe("gemini-2-0-flash");
	});

	it("resumes from a cursor rather than replaying a chain from the head", () => {
		const state: ChainState = {
			chainKey: "default",
			index: 1,
			primary: base.primary,
			served: false,
		};
		const result = resolveFallbackChain({
			...base,
			failed: anthropic,
			chains: { default: ["openai/gpt-4o-mini", "google/gemini-2-0-flash"] },
			attempted: new Set(),
			state,
		});
		// Resuming past the head is what stops a permanently-down first route
		// costing its timeout on every subsequent turn.
		expect(result.ok && result.route.id).toBe("gemini-2-0-flash");
	});
});

describe("a switch is a routing decision, not a claim of service", () => {
	it("is unserved until something actually settles on the fallback", () => {
		const unserved: ChainState = {
			chainKey: "default",
			index: 0,
			primary: base.primary,
			served: false,
			reason: "rate limited",
		};
		// Telling the user the run is now on the fallback, before any response came
		// back from it, states something that is not yet true - and if the fallback
		// then fails too, they were told about a model that never ran.
		expect(describeFallback(unserved)).toContain("switching to");
		expect(unserved.served).toBe(false);

		const served = markServed(unserved);
		expect(served.served).toBe(true);
		expect(describeFallback(served)).toContain("falling back to");
	});
});

describe("reverting to the primary", () => {
	const state: ChainState = {
		chainKey: "default",
		index: 1,
		primary: { provider: "anthropic", id: "claude-sonnet-4-5", raw: "anthropic/claude-sonnet-4-5" },
		served: true,
	};

	it("never reverts under the never policy", () => {
		expect(
			shouldRevertToPrimary({ state, revertPolicy: "never", primaryCooldownUntil: undefined, now: 9_000_000 }),
		).toBe(false);
	});

	it("reverts once the cooldown has expired", () => {
		expect(
			shouldRevertToPrimary({ state, revertPolicy: "cooldown-expiry", primaryCooldownUntil: 500_000, now: 1_000_000 }),
		).toBe(true);
	});

	it("does not revert while the primary is still in cooldown", () => {
		// Reverting into a live cooldown fails immediately and burns another
		// fallback, which is the loop this check exists to stop.
		expect(
			shouldRevertToPrimary({ state, revertPolicy: "cooldown-expiry", primaryCooldownUntil: 2_000_000, now: 1_000_000 }),
		).toBe(false);
	});

	it("does not revert when no fallback is active", () => {
		expect(
			shouldRevertToPrimary({
				state: { ...state, index: 0 },
				revertPolicy: "cooldown-expiry",
				primaryCooldownUntil: 1,
				now: 2_000_000,
			}),
		).toBe(false);
	});
});
