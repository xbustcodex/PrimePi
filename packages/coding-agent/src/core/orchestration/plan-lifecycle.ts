/**
 * The plan lifecycle: state, transitions, and the indicator a UI renders.
 *
 * ## Why this exists separately from goal and todo state
 *
 * Source tracing found that OMP's plan state is genuinely three things in
 * disagreement: two booleans on `InteractiveMode`, an optional `PlanModeState` on
 * the session, and a journaled `mode_change` of `"plan" | "plan_paused" | "none"`.
 * There is no approved state anywhere — approval lives outside the machine in
 * `#planReferencePath`, untouched by teardown.
 *
 * That accidental arrangement is why OMP's toggle does not discard an approved
 * plan, and equally why its UI can report "Plan Mode is active" while an approved
 * plan is still attached. This module makes the states explicit instead, so
 * "approved plan guiding implementation" is a state a caller can read rather than
 * infer from the absence of a flag.
 *
 * It is deliberately plan-only. Goals and todos are separate concerns with no
 * data coupling to a plan — OMP has none, and manufacturing a link would be a
 * fabrication. A later phase composes the three; the invariants between them are
 * enforced at that composition point.
 */

import {
	approvePlan,
	beginPlanning,
	clearPlan,
	hasApprovedPlan,
	hasUnapprovedDraft,
	INITIAL_PLAN_STATE,
	isWriteBarrierActive,
	leavePlanning,
	type PlanState,
	planStateFromRecord,
	recordDraft,
	rejectPlan,
	resetPlanIdCounter,
	snapshotPlanState,
	supersedePlan,
} from "./plan-state.ts";

/**
 * How a plan reads to a user.
 *
 * Three strings, not two, because "planning", "approved and still attached", and
 * "nothing" are genuinely different situations and collapsing any pair of them
 * produces a lie. In particular an approved plan must never be reported as
 * "plan mode active" merely because it is still attached.
 */
export type PlanIndicator = "PLAN MODE ACTIVE" | "APPROVED PLAN GUIDING IMPLEMENTATION" | "NO ACTIVE PLAN";

/** A one-line description naming the state, for a status message. */
export function describePlanState(state: PlanState): string {
	if (state.phase === "planning") return "Planning in progress.";
	if (hasApprovedPlan(state)) {
		return `Approved plan "${state.plan?.title}" is guiding implementation.`;
	}
	if (state.unapproved && state.plan) {
		return "An unapproved draft is attached; it is not implementation authority.";
	}
	if (state.plan) return "A plan was superseded or rejected.";
	return "No active plan.";
}

/**
 * Holds and transitions the plan state.
 *
 * Free of session, file, and UI references, so the whole state machine is
 * testable without a session — the property that lets OMP unit-test `GoalRuntime`
 * against a plain object host, and the reason this class exists separately from
 * the session.
 */
export class PlanLifecycle {
	#state: PlanState = { ...INITIAL_PLAN_STATE };

	/** The current state, safe to hand to a caller. */
	get state(): PlanState {
		return snapshotPlanState(this.#state);
	}

	/** Whether writes to the working tree are currently refused. */
	get writeBarrierActive(): boolean {
		return isWriteBarrierActive(this.#state);
	}

	/** Whether an approved plan is available as implementation guidance. */
	get hasApprovedPlan(): boolean {
		return hasApprovedPlan(this.#state);
	}

	/** Whether a draft exists that was never approved. */
	get hasUnapprovedDraft(): boolean {
		return hasUnapprovedDraft(this.#state);
	}

	/** Enters planning. Any attached plan is superseded, not reused. */
	beginPlanning(now: number): void {
		this.#state = beginPlanning(this.#state, now);
	}

	/** Records a draft the agent produced. Does not approve it. */
	recordDraft(input: { id?: string; title: string; content: string; now: number }): void {
		this.#state = recordDraft(this.#state, input);
	}

	/** Approves the attached plan. The write barrier lifts; the plan stays. */
	approvePlan(now: number): void {
		this.#state = approvePlan(this.#state, now);
	}

	/** Rejects the plan, optionally keeping the draft for refinement. */
	rejectPlan(now: number, options: { keepDraft?: boolean } = {}): void {
		this.#state = rejectPlan(this.#state, { now, keepDraft: options.keepDraft });
	}

	/**
	 * Leaves planning without touching the attached plan.
	 *
	 * An approved plan survives and remains guidance. An unapproved draft is
	 * retained and flagged, but is not promoted to authority — which is the
	 * regression this transition exists to prevent.
	 */
	leavePlanning(now: number): void {
		this.#state = leavePlanning(this.#state, now);
	}

	/** Explicitly supersedes the attached plan. */
	supersedePlan(now: number): void {
		this.#state = supersedePlan(this.#state, now);
	}

	/** Explicitly clears the attached plan. */
	clearPlan(now: number): void {
		this.#state = clearPlan(this.#state, now);
	}

	/** Restores from a persisted record, tolerating absent or corrupt data. */
	restore(record: unknown): void {
		this.#state = planStateFromRecord(record);
	}

	/** A serializable snapshot, for the session journal. */
	snapshot(): PlanState {
		return this.state;
	}

	/** Resets to the initial state. */
	reset(): void {
		this.#state = { ...INITIAL_PLAN_STATE };
	}
}

/** The plan-state projection a UI renders. */
export function planIndicator(state: PlanState): PlanIndicator {
	if (state.phase === "planning") return "PLAN MODE ACTIVE";
	if (hasApprovedPlan(state)) return "APPROVED PLAN GUIDING IMPLEMENTATION";
	return "NO ACTIVE PLAN";
}

export { resetPlanIdCounter };
