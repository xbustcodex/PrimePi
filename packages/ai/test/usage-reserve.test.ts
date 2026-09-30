import { describe, expect, it } from "vitest";
import {
	accountState,
	classifyUsage,
	decideReserveAction,
	evaluateCandidate,
	shouldReleaseAccountLease,
	type UsageAccount,
} from "../src/utils/usage-reserve.ts";

/**
 * Usage-aware fallback.
 *
 * Two properties carry this module, and both are about not spending money
 * quietly. **An unreported reading is `unknown`, not `depleted`** — a provider
 * that publishes no usage is not a provider that is out of usage, and failing
 * closed on it would block every session. And **`fail-closed` throws even when a
 * healthy account exists**, because silently switching spends the margin while
 * reporting a normal turn, which is exactly what the setting forbids.
 */

const MARGIN = 0.2;

const usage = (remaining: number | null) => classifyUsage({ remaining, reserveFraction: MARGIN });

describe("an unreported reading is unknown, not depleted", () => {
	it("passes on a null reading", () => {
		// A provider that publishes no usage is not a provider that is out of usage.
		expect(usage(null).state).toBe("unknown");
	});

	it("passes on a non-finite reading", () => {
		expect(usage(Number.NaN).state).toBe("unknown");
	});

	it("proceeds under fail-closed on unknown", () => {
		// Failing closed here would block every session against such a provider, which
		// is a worse failure than spending the margin.
		const decision = decideReserveAction({
			policy: "fail-closed",
			health: usage(null),
			selector: "openai/gpt-5",
		});
		expect(decision.action).toBe("proceed");
	});
});

describe("classification", () => {
	it("is healthy above the margin", () => {
		expect(usage(0.5).state).toBe("healthy");
	});

	it("is in reserve below the margin", () => {
		expect(usage(0.1).state).toBe("reserve");
	});

	it("is depleted at zero", () => {
		expect(usage(0).state).toBe("depleted");
	});

	it("treats the margin as a strict bound", () => {
		expect(usage(MARGIN).state).toBe("healthy");
		expect(usage(MARGIN - 0.001).state).toBe("reserve");
	});

	it("clamps a nonsensical margin instead of marking everything in reserve", () => {
		// A negative margin would classify every account as inside it.
		expect(classifyUsage({ remaining: 0.9, reserveFraction: -5 }).state).toBe("healthy");
		// A margin above 1 clamps to 1, so only a fully spent account is in reserve.
		expect(classifyUsage({ remaining: 0.5, reserveFraction: 99 }).state).toBe("reserve");
		expect(classifyUsage({ remaining: 1, reserveFraction: 99 }).state).toBe("healthy");
	});
});

describe("fail-closed is about new work, not the session", () => {
	it("throws on reserve", () => {
		const decision = decideReserveAction({ policy: "fail-closed", health: usage(0.1), selector: "openai/gpt-5" });
		expect(decision.action).toBe("fail-closed");
		if (decision.action !== "fail-closed") return;
		expect(decision.reason).toContain("reserve reached");
	});

	it("throws on depleted", () => {
		const decision = decideReserveAction({ policy: "fail-closed", health: usage(0), selector: "openai/gpt-5" });
		expect(decision.action).toBe("fail-closed");
		if (decision.action !== "fail-closed") return;
		expect(decision.reason).toContain("usage depleted");
	});

	it("names the selector, so the message is actionable", () => {
		const decision = decideReserveAction({ policy: "fail-closed", health: usage(0.1), selector: "openai/gpt-5" });
		if (decision.action !== "fail-closed") return;
		expect(decision.reason).toContain("openai/gpt-5");
	});
});

describe("approval is remembered per selector", () => {
	it("asks again for a different selector", () => {
		// Approving one model says nothing about another.
		const decision = decideReserveAction({
			policy: "confirm",
			health: usage(0.1),
			selector: "openai/gpt-5",
			approvedSelector: "openai/o3",
		});
		expect(decision.action).toBe("confirm");
	});

	it("proceeds for the selector that was approved", () => {
		const decision = decideReserveAction({
			policy: "confirm",
			health: usage(0.1),
			selector: "openai/gpt-5",
			approvedSelector: "openai/gpt-5",
		});
		expect(decision.action).toBe("proceed");
	});

	it("still asks when the account is fully spent", () => {
		// The user approved spending the margin, not spending the account.
		const decision = decideReserveAction({
			policy: "confirm",
			health: usage(0),
			selector: "openai/gpt-5",
			approvedSelector: "openai/gpt-5",
		});
		expect(decision.action).toBe("confirm");
	});

	it("switches to a different route without asking", () => {
		const decision = decideReserveAction({ policy: "auto", health: usage(0.1), selector: "openai/gpt-5" });
		expect(decision.action).toBe("confirm");
		if (decision.action !== "confirm") return;
		expect(decision.reason).toContain("reserve reached");
	});
});

describe("a candidate must fit as well as have usage", () => {
	const check = (overrides: Partial<Parameters<typeof evaluateCandidate>[0]> = {}) =>
		evaluateCandidate({
			candidate: "anthropic/claude",
			health: usage(0.9),
			contextFits: true,
			hasConfiguredAuth: true,
			...overrides,
		});

	it("accepts a healthy candidate", () => {
		expect(check().usable).toBe(true);
	});

	it("rejects a candidate whose window cannot hold the live context", () => {
		// Switching onto it would convert a usage problem into a context-overflow one,
		// which is strictly worse and far harder to diagnose.
		expect(check({ contextFits: false })).toMatchObject({ usable: false, reason: "context-overflow" });
	});

	it("checks fit before usage, because fit is wrong either way", () => {
		expect(check({ contextFits: false, health: usage(0) }).reason).toBe("context-overflow");
	});

	it("rejects a candidate in reserve or depleted", () => {
		expect(check({ health: usage(0.1) })).toMatchObject({ usable: false, reason: "reserve" });
		expect(check({ health: usage(0) })).toMatchObject({ usable: false, reason: "depleted" });
	});

	it("rejects a candidate with no configured credential", () => {
		expect(check({ hasConfiguredAuth: false })).toMatchObject({ usable: false, reason: "no-auth" });
	});

	it("still accepts a candidate whose usage could not be read", () => {
		// Refusing every candidate on unreadable usage would end the turn with
		// nothing, which is worse than trying one.
		expect(check({ health: usage(null) }).usable).toBe(true);
	});
});

describe("releasing a pinned account lease", () => {
	const accounts: UsageAccount[] = [
		{ id: "a", remaining: 0.1, state: "reserve", selected: true },
		{ id: "b", remaining: 0.9, state: "healthy" },
	];

	it("releases a lease pinned to a worse account than necessary", () => {
		expect(
			shouldReleaseAccountLease({ health: { state: "reserve", accounts }, selectedAccountState: "reserve" }),
		).toBe(true);
	});

	it("keeps a healthy lease", () => {
		expect(
			shouldReleaseAccountLease({ health: { state: "healthy", accounts }, selectedAccountState: "healthy" }),
		).toBe(false);
	});

	it("keeps the lease when no account is healthy", () => {
		const allSpent: UsageAccount[] = [{ id: "a", remaining: 0, state: "depleted", selected: true }];
		expect(
			shouldReleaseAccountLease({
				health: { state: "depleted", accounts: allSpent },
				selectedAccountState: "depleted",
			}),
		).toBe(false);
	});
});

describe("per-account classification", () => {
	it("uses the same margin as the provider total", () => {
		expect(accountState({ id: "a", remaining: 0.1 }, MARGIN)).toBe("reserve");
		expect(accountState({ id: "a", remaining: 0.9 }, MARGIN)).toBe("healthy");
	});
});
