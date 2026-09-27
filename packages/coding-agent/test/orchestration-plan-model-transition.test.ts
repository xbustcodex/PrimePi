import type { Api, Model, RoleChainCandidate } from "@earendil-works/pi-ai";
import { MODEL_ROLES, resolveRoleChain } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	planRoleEligibility,
	resolvePlanExitTransition,
	resolvePlanModelTransition,
} from "../src/core/orchestration/plan-model-transition.ts";

/**
 * Plan-mode model transitions, and the guarantee that matters most: a plan role
 * **proposes** like every other role, so a configured preference cannot reach a
 * model that the access, credential, free-only, or provider gates exclude.
 *
 * OMP's plan path is weaker than its normal role path — the trace found it skips
 * `resolveRoleChain` and discards `resolved.warning`. These tests pin the stronger
 * behaviour: unconfigured means no switch, and an ineligible target yields no
 * model rather than one that bypassed a gate.
 */

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		api: "anthropic-messages",
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

const sessionModel = model("openrouter", "vendor/a:free", { free: true });
const planModel = model("anthropic", "claude-sonnet-4-5");
const paidPlan = model("anthropic", "claude-opus-5", { cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } });

function candidate(m: Model<Api>): RoleChainCandidate {
	return { model: m, pattern: `${m.provider}/${m.id}`, explicit: true, fromFallback: false, thinking: {} };
}

describe("the plan role is available", () => {
	it("is declared and active", () => {
		expect(MODEL_ROLES.plan.activeInPi).toBe(true);
		expect(MODEL_ROLES.plan.section).toBe("chat");
	});

	it("names a consumer, so activation is not a dead control", () => {
		expect(MODEL_ROLES.plan.consumer).toBe("plan mode model transition on entry");
	});
});

describe("entering plan mode", () => {
	it("leaves the model alone when the role is unconfigured", () => {
		// OMP's first rule, preserved: an unconfigured role never moves the user off
		// their own model, which is the default out of the box.
		const transition = resolvePlanModelTransition({ current: sessionModel, candidates: [], isStreaming: false });
		expect(transition.kind).toBe("none");
	});

	it("applies the plan model when the role resolves", () => {
		const transition = resolvePlanModelTransition({
			current: sessionModel,
			candidates: [candidate(planModel)],
			isStreaming: false,
		});
		expect(transition.kind).toBe("apply");
		if (transition.kind !== "apply") throw new Error("expected apply");
		expect(transition.model).toBe(planModel);
		expect(transition.deferred).toBe(false);
	});

	it("defers the switch while a turn is streaming", () => {
		// Swapping the model mid-stream would invalidate the turn in flight.
		const transition = resolvePlanModelTransition({
			current: sessionModel,
			candidates: [candidate(planModel)],
			isStreaming: true,
		});
		expect(transition.kind).toBe("apply");
		if (transition.kind !== "apply") throw new Error("expected apply");
		expect(transition.deferred).toBe(true);
	});

	it("applies only a thinking level when the model already matches", () => {
		const transition = resolvePlanModelTransition({
			current: planModel,
			candidates: [candidate(planModel)],
			isStreaming: false,
			thinkingLevel: "high",
		});
		expect(transition.kind).toBe("thinking");
	});

	it("does nothing when the model matches and no level is configured", () => {
		const transition = resolvePlanModelTransition({
			current: planModel,
			candidates: [candidate(planModel)],
			isStreaming: false,
		});
		expect(transition.kind).toBe("none");
	});

	it("carries no thinking level when none is configured", () => {
		const transition = resolvePlanModelTransition({
			current: sessionModel,
			candidates: [candidate(planModel)],
			isStreaming: false,
		});
		expect(transition.kind).toBe("apply");
		if (transition.kind !== "apply") throw new Error("expected apply");
		expect(transition.thinkingLevel).toBeUndefined();
	});
});

describe("leaving plan mode", () => {
	it("restores the pre-plan model", () => {
		const transition = resolvePlanExitTransition({ current: planModel, restoreTo: sessionModel, isStreaming: false });
		expect(transition.kind).toBe("apply");
		if (transition.kind !== "apply") throw new Error("expected apply");
		expect(transition.model).toBe(sessionModel);
	});

	it("defers the restore while streaming", () => {
		const transition = resolvePlanExitTransition({ current: planModel, restoreTo: sessionModel, isStreaming: true });
		expect(transition.kind === "apply" && transition.deferred).toBe(true);
	});

	it("keeps the model when none was captured", () => {
		expect(resolvePlanExitTransition({ current: planModel, restoreTo: undefined, isStreaming: false }).kind).toBe(
			"none",
		);
	});

	it("does nothing when already on the pre-plan model", () => {
		expect(
			resolvePlanExitTransition({ current: sessionModel, restoreTo: sessionModel, isStreaming: false }).kind,
		).toBe("none");
	});

	it("does not hold the plan model for an approved plan", () => {
		// The plan is guidance delivered as text, not a reason to pin a different
		// model for the rest of the session.
		const transition = resolvePlanExitTransition({ current: planModel, restoreTo: sessionModel, isStreaming: false });
		expect(transition.kind === "apply" && transition.model).toBe(sessionModel);
	});
});

describe("the plan role cannot reach an ineligible model", () => {
	const available = [planModel, paidPlan, sessionModel];

	function resolveWith(eligibility: Parameters<typeof resolveRoleChain>[0]["eligibility"]) {
		return resolveRoleChain({
			role: "plan",
			configured: { plan: "anthropic/claude-opus-5" },
			available,
			eligibility,
		});
	}

	it("keeps a free candidate under a free-only policy", () => {
		// The chain fails closed without a credential probe, so a reachable provider
		// must be declared as one — which is what a real session does.
		const result = resolveRoleChain({
			role: "plan",
			configured: { plan: "openrouter/vendor/a:free" },
			available,
			eligibility: planRoleEligibility({
				sessionModel,
				policy: "free-only",
				credentialMissing: () => false,
				disabledProviders: new Set(),
			}),
		});
		expect(result.candidates.map((c) => c.model.id)).toContain("vendor/a:free");
	});

	it("drops a candidate whose provider is disabled", () => {
		const result = resolveWith(
			planRoleEligibility({ sessionModel, policy: "compatible", disabledProviders: new Set(["anthropic"]) }),
		);
		expect(result.candidates).toEqual([]);
		expect(result.rejected.some((r) => r.reason === "disabled-provider")).toBe(true);
	});

	it("drops a candidate with no reachable credential", () => {
		const result = resolveWith(
			planRoleEligibility({
				sessionModel,
				policy: "compatible",
				credentialMissing: (provider) => provider === "anthropic",
				disabledProviders: new Set(),
			}),
		);
		expect(result.candidates).toEqual([]);
		expect(result.rejected.some((r) => r.reason === "missing-credential")).toBe(true);
	});

	it("produces no model at all when everything is excluded, so the session keeps its own", () => {
		const result = resolveWith(
			planRoleEligibility({ sessionModel, policy: "compatible", disabledProviders: new Set(["anthropic"]) }),
		);
		// And the transition that consumes this result is a no-op, not a switch to
		// some fallback.
		const transition = resolvePlanModelTransition({
			current: sessionModel,
			candidates: result.candidates,
			isStreaming: false,
		});
		expect(transition.kind).toBe("none");
	});

	it("treats an absent policy as the most restrictive", () => {
		const eligibility = planRoleEligibility({ sessionModel, policy: undefined, disabledProviders: new Set() });
		expect(eligibility.policy).toBe("free-only");
	});

	it("a preference for a paid plan model cannot force a free-only session onto it", () => {
		// The adversarial shape: configuration names exactly the model the policy
		// forbids, and it is the only configured candidate.
		const result = resolveWith(
			planRoleEligibility({ sessionModel, policy: "free-only", disabledProviders: new Set() }),
		);
		expect(result.candidates.every((c) => c.model.free === true)).toBe(true);
		expect(
			resolvePlanModelTransition({ current: sessionModel, candidates: result.candidates, isStreaming: false }).kind,
		).toBe("none");
	});
});
