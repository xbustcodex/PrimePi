import { describe, expect, it } from "vitest";
import {
	approvePlan,
	beginPlanning,
	clearPlan,
	hasApprovedPlan,
	hasUnapprovedDraft,
	INITIAL_PLAN_STATE,
	isWriteBarrierActive,
	leavePlanning,
	planStateFromRecord,
	recordDraft,
	rejectPlan,
	resetPlanIdCounter,
	supersedePlan,
} from "../src/core/orchestration/plan-state.ts";

/**
 * The plan state machine.
 *
 * OMP models this as two booleans plus a four-field `PlanModeState` with no
 * approval state at all (`PlanModeStateMachine` trace §1-2). These tests pin the
 * property that makes the difference observable: an approved plan is a state,
 * distinct from both "planning" and "no plan", and it survives the mode toggle.
 */

const T0 = 1_000_000;

function planningWithDraft() {
	const state = recordDraft(beginPlanning(INITIAL_PLAN_STATE, T0), {
		title: "Add auth",
		content: "# Plan\n\n1. Add token refresh",
		now: T0 + 10,
	});
	return state;
}

describe("entering and leaving planning", () => {
	it("starts inactive with no barrier", () => {
		expect(INITIAL_PLAN_STATE.phase).toBe("inactive");
		expect(isWriteBarrierActive(INITIAL_PLAN_STATE)).toBe(false);
	});

	it("raises the write barrier on entry", () => {
		const state = beginPlanning(INITIAL_PLAN_STATE, T0);
		expect(state.phase).toBe("planning");
		expect(isWriteBarrierActive(state)).toBe(true);
	});

	it("keeps the barrier up while a draft is under review", () => {
		expect(isWriteBarrierActive(planningWithDraft())).toBe(true);
	});

	it("lowers the barrier once the plan is approved", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		expect(approved.phase).toBe("approved");
		expect(isWriteBarrierActive(approved)).toBe(false);
	});

	it("supersedes an approved plan when planning is re-entered", () => {
		// Re-entering means the user wants a new plan. Carrying the old approval
		// forward would make it ambiguous which plan the next approval governs.
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		const reentered = beginPlanning(approved, T0 + 30);
		expect(reentered.phase).toBe("planning");
		expect(reentered.plan).toBeUndefined();
		expect(hasApprovedPlan(reentered)).toBe(false);
	});

	it("drops the barrier when leaving with no plan at all", () => {
		const state = leavePlanning(beginPlanning(INITIAL_PLAN_STATE, T0), T0 + 5);
		expect(state.phase).toBe("inactive");
		expect(state.unapproved).toBe(false);
	});
});

describe("approval", () => {
	it("records an approval timestamp", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		expect(approved.plan?.approvedAt).toBe(T0 + 20);
		expect(approved.unapproved).toBe(false);
	});

	it("is a no-op with no plan attached", () => {
		const state = { ...INITIAL_PLAN_STATE };
		expect(approvePlan(state, T0)).toBe(state);
	});

	it("keeps the plan body so it can guide implementation after a mode toggle", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		expect(approved.plan?.content).toContain("Add token refresh");
		expect(approved.plan?.title).toBe("Add auth");
	});
});

describe("rejection", () => {
	it("keeps the draft for refinement and keeps the barrier up", () => {
		const rejected = rejectPlan(planningWithDraft(), { now: T0 + 30, keepDraft: true });
		expect(rejected.phase).toBe("planning");
		expect(rejected.unapproved).toBe(true);
		expect(isWriteBarrierActive(rejected)).toBe(true);
	});

	it("clears the plan when the draft is not kept", () => {
		const rejected = rejectPlan(planningWithDraft(), { now: T0 + 30 });
		expect(rejected.phase).toBe("superseded");
		expect(hasApprovedPlan(rejected)).toBe(false);
	});

	it("never approves a rejected plan", () => {
		const rejected = rejectPlan(planningWithDraft(), { now: T0 + 30 });
		const late = approvePlan(rejected, T0 + 40);
		// The approval stamps a timestamp on a plan that is no longer under review,
		// so `hasApprovedPlan` still requires the approved phase.
		expect(late.phase).toBe("superseded");
		expect(hasApprovedPlan(late)).toBe(false);
	});
});

describe("THE regression: approve, disable, implement, add a goal", () => {
	it("keeps the approved plan as guidance after plan mode is turned off", () => {
		let state = beginPlanning(INITIAL_PLAN_STATE, T0);
		state = recordDraft(state, { title: "Add auth", content: "# Plan\n\n1. Add token refresh", now: T0 + 10 });
		state = approvePlan(state, T0 + 20);
		expect(state.phase).toBe("approved");

		// Plan mode off. This is the step OMP gets right only by accident: its
		// teardown never touches the plan reference, so approval survives.
		state = leavePlanning(state, T0 + 30);

		// The plan is still attached and still authoritative as guidance.
		expect(state.phase).toBe("approved");
		expect(hasApprovedPlan(state)).toBe(true);
		expect(state.plan?.content).toContain("Add token refresh");

		// And implementation is unblocked: the barrier is down.
		expect(isWriteBarrierActive(state)).toBe(false);
	});
});

describe("THE regression: an unapproved draft must not become authority", () => {
	it("does not become guidance when plan mode is disabled before approval", () => {
		const withDraft = planningWithDraft();
		expect(hasUnapprovedDraft(withDraft)).toBe(true);

		// Disabling before approval is the dangerous transition.
		const left = leavePlanning(withDraft, T0 + 30);

		// The draft is retained for reference...
		expect(left.plan?.content).toContain("Add token refresh");
		expect(left.unapproved).toBe(true);
		// ...but it is explicitly not authority.
		expect(hasApprovedPlan(left)).toBe(false);
		expect(left.phase).not.toBe("approved");
	});
});

describe("explicit supersede and clear", () => {
	it("supersede withdraws authority but retains the plan for display", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		const superseded = supersedePlan(approved, T0 + 30);
		expect(superseded.phase).toBe("superseded");
		expect(hasApprovedPlan(superseded)).toBe(false);
		expect(superseded.plan?.title).toBe("Add auth");
	});

	it("clear removes the plan entirely, which supersede does not", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);

		const superseded = supersedePlan(approved, T0 + 30);
		expect(superseded.plan).toBeDefined();

		const cleared = clearPlan(superseded, T0 + 40);
		expect(cleared.plan).toBeUndefined();
		expect(cleared.phase).toBe("inactive");
		expect(cleared.lastEnd?.reason).toBe("cleared");
	});

	it("decouples destruction from the mode toggle", () => {
		// Two sessions in the same state, one toggled off and one explicitly
		// cleared. The toggle keeps the plan; only clear removes it.
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		const toggled = leavePlanning(approved, T0 + 30);
		const explicitlyCleared = clearPlan(approved, T0 + 30);

		expect(toggled.plan).toBeDefined();
		expect(explicitlyCleared.plan).toBeUndefined();
	});
});

describe("persistence", () => {
	it("round-trips through a record", () => {
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		const restored = planStateFromRecord(JSON.parse(JSON.stringify(approved)));
		expect(restored.phase).toBe("approved");
		expect(restored.plan?.title).toBe("Add auth");
		expect(restored.plan?.content).toContain("Add token refresh");
		expect(hasApprovedPlan(restored)).toBe(true);
	});

	it("survives a compaction that rewrites only the message list", () => {
		// Compaction rewrites the projected messages; the plan is separate state and
		// must be unaffected. Simulated by round-tripping through serialization
		// after an unrelated state change, which is what a compaction boundary does.
		const approved = approvePlan(planningWithDraft(), T0 + 20);
		const unrelated = { ...approved, lastEnd: undefined };
		const restored = planStateFromRecord(JSON.parse(JSON.stringify(unrelated)));
		expect(hasApprovedPlan(restored)).toBe(true);
	});

	it("downgrades an approved phase that has no approval timestamp", () => {
		// A hand-edited or truncated journal must not be able to manufacture
		// implementation authority by writing the phase alone.
		const forged = planStateFromRecord({
			phase: "approved",
			plan: { id: "p", title: "t", content: "c", createdAt: 1 },
		});
		expect(forged.unapproved).toBe(true);
		expect(hasApprovedPlan(forged)).toBe(false);
	});

	it("falls back to inactive for an unknown phase", () => {
		expect(planStateFromRecord({ phase: "nonsense" }).phase).toBe("inactive");
		expect(planStateFromRecord(undefined).phase).toBe("inactive");
		expect(planStateFromRecord("garbage").phase).toBe("inactive");
	});

	it("generates distinct plan ids", () => {
		resetPlanIdCounter();
		const first = recordDraft(beginPlanning(INITIAL_PLAN_STATE, T0), { title: "a", content: "a", now: T0 });
		const second = recordDraft(beginPlanning(INITIAL_PLAN_STATE, T0), { title: "b", content: "b", now: T0 });
		expect(first.plan?.id).not.toBe(second.plan?.id);
	});
});
