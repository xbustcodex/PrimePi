/**
 * Orchestration: the plan / goal / TODO state machine, as one object.
 *
 * ## Why one object
 *
 * OMP keeps these in three unrelated places: plan state on `InteractiveMode` plus
 * a `PlanModeState` on the session, goal state in `AgentSession.#goalModeState`,
 * and todos in a `TodoTracker` that rehydrates from the branch. That works there
 * because the modes are strictly mutually exclusive, so the three can never
 * disagree.
 *
 * This port relaxes that: a goal may be added while an approved plan guides
 * implementation, which is a stated requirement. Once they can coexist, the
 * invariant that keeps them honest has to be enforced rather than assumed — so
 * they live together and the transitions that could corrupt one are rejected
 * explicitly.
 *
 * The invariant: **goal and todo operations never mutate plan state.** A goal
 * added mid-implementation cannot rewrite the plan, because there is no code path
 * from one to the other.
 */

import { addGoal, type GoalState, goalStateFromRecord, INITIAL_GOAL_STATE, snapshotGoalState } from "./goal-state.ts";
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
	snapshotPlanState,
	supersedePlan,
} from "./plan-state.ts";
import { snapshotTodoState, type TodoState, todoStateFromRecord } from "./todo-state.ts";

export interface OrchestrationState {
	plan: PlanState;
	goal: GoalState;
	todo: TodoState;
}

export const INITIAL_ORCHESTRATION_STATE: OrchestrationState = {
	plan: { ...INITIAL_PLAN_STATE },
	goal: { ...INITIAL_GOAL_STATE },
	todo: { phases: [] },
};

/**
 * The plan-state projection a UI renders.
 *
 * Four distinct strings, because the requirement is that these be
 * distinguishable and OMP's two-boolean model collapses two of them. In
 * particular `PLAN MODE ACTIVE` is only correct when the phase is `planning`, and
 * an approved plan that happens to still be attached must not be reported as an
 * active plan mode.
 */
export type PlanIndicator = "PLAN MODE ACTIVE" | "APPROVED PLAN GUIDING IMPLEMENTATION" | "NO ACTIVE PLAN";

export function planIndicator(state: OrchestrationState): PlanIndicator {
	const { plan } = state;
	if (plan.phase === "planning") return "PLAN MODE ACTIVE";
	if (hasApprovedPlan(plan)) return "APPROVED PLAN GUIDING IMPLEMENTATION";
	return "NO ACTIVE PLAN";
}

/** A one-line summary for a status line, including the budget when present. */
export function goalIndicator(state: OrchestrationState): string | undefined {
	const goal = state.goal.current;
	if (!goal || goal.status === "dropped" || goal.status === "complete") return undefined;
	const budget = goal.tokenBudget === undefined ? `${goal.tokensUsed}` : `${goal.tokensUsed}/${goal.tokenBudget}`;
	return `GOAL ${goal.status} ${budget}`;
}

/** A one-line summary of open TODO work. */
export function todoIndicator(state: OrchestrationState): string | undefined {
	const open = state.todo.phases
		.flatMap((phase) => phase.tasks)
		.filter((task) => task.status !== "completed" && task.status !== "abandoned");
	if (open.length === 0) return undefined;
	const active = open.find((task) => task.status === "in_progress");
	return `TODO ${open.length} open${active ? `: ${active.content}` : ""}`;
}

/**
 * Holds and transitions the orchestration state.
 *
 * Deliberately free of session, file, and UI references so the whole state
 * machine is testable without a session — the same property that lets OMP unit
 * test `GoalRuntime` against a plain object host.
 */
export class Orchestration {
	#state: OrchestrationState = {
		plan: { ...INITIAL_PLAN_STATE },
		goal: { ...INITIAL_GOAL_STATE },
		todo: { phases: [] },
	};

	/** The current state, safe to hand to a caller. */
	get state(): OrchestrationState {
		return {
			plan: snapshotPlanState(this.#state.plan),
			goal: snapshotGoalState(this.#state.goal),
			todo: snapshotTodoState(this.#state.todo),
		};
	}

	/** Plan state alone, for the approval gate's hot path. */
	get plan(): PlanState {
		return this.#state.plan;
	}

	get goal(): GoalState {
		return this.#state.goal;
	}

	get todo(): TodoState {
		return this.#state.todo;
	}

	/** Whether writes to the working tree are currently refused. */
	get writeBarrierActive(): boolean {
		return isWriteBarrierActive(this.#state.plan);
	}

	/** Whether an approved plan is available as implementation guidance. */
	get hasApprovedPlan(): boolean {
		return hasApprovedPlan(this.#state.plan);
	}

	/** Whether a draft exists that was never approved. */
	get hasUnapprovedDraft(): boolean {
		return hasUnapprovedDraft(this.#state.plan);
	}

	// --- Plan transitions -----------------------------------------------------

	/** Enters planning. Any attached plan is superseded, not reused. */
	beginPlanning(now: number): void {
		this.#state.plan = beginPlanning(this.#state.plan, now);
	}

	/** Records a draft the agent produced. Does not approve it. */
	recordDraft(input: { id?: string; title: string; content: string; now: number }): void {
		this.#state.plan = recordDraft(this.#state.plan, input);
	}

	/** Approves the attached plan. The write barrier lifts; the plan stays. */
	approvePlan(now: number): void {
		this.#state.plan = approvePlan(this.#state.plan, now);
	}

	/** Rejects the plan, optionally keeping the draft for refinement. */
	rejectPlan(now: number, options: { keepDraft?: boolean } = {}): void {
		this.#state.plan = rejectPlan(this.#state.plan, { now, keepDraft: options.keepDraft });
	}

	/**
	 * Leaves planning without touching the attached plan.
	 *
	 * An approved plan survives and remains guidance. An unapproved draft is
	 * retained and flagged, but is not promoted to authority.
	 */
	leavePlanning(now: number): void {
		this.#state.plan = leavePlanning(this.#state.plan, now);
	}

	/** Explicitly supersedes the attached plan. */
	supersedePlan(now: number): void {
		this.#state.plan = supersedePlan(this.#state.plan, now);
	}

	/** Explicitly clears the attached plan. */
	clearPlan(now: number): void {
		this.#state.plan = clearPlan(this.#state.plan, now);
	}

	// --- Goal transitions -----------------------------------------------------

	/**
	 * Adds or replaces the current goal.
	 *
	 * Never touches plan state — that is the invariant this whole module exists
	 * to keep, and it is why adding work during implementation cannot rewrite an
	 * approved plan.
	 */
	addGoal(input: { objective: string; tokenBudget?: number; now: number }): void {
		this.#state.goal = addGoal(this.#state.goal, input);
	}

	/**
	 * Replaces the goal state wholesale.
	 *
	 * The write path the accounting and the `goal` tool both use, so neither can
	 * hold a second copy of the state that drifts from this one. Never touches
	 * plan state, for the same reason `addGoal` does not.
	 */
	setGoalState(state: GoalState): void {
		this.#state.goal = snapshotGoalState(state);
	}

	/** Removes the current goal. Never touches plan state. */
	clearGoal(): void {
		this.#state.goal = { ...INITIAL_GOAL_STATE };
	}

	// --- TODO transitions -----------------------------------------------------

	/** Replaces the TODO list wholesale. Never touches plan or goal state. */
	setTodo(state: TodoState): void {
		this.#state.todo = snapshotTodoState(state);
	}

	// --- Serialization --------------------------------------------------------

	/**
	 * Restores state from a persisted record.
	 *
	 * Each subsystem restores independently, so a record missing or corrupting one
	 * does not discard the others.
	 */
	restore(record: { plan?: unknown; goal?: unknown; todo?: unknown } | undefined): void {
		this.#state = {
			plan: planStateFromRecord(record?.plan),
			goal: goalStateFromRecord(record?.goal),
			todo: todoStateFromRecord(record?.todo),
		};
	}

	/** A serializable snapshot, for the session journal. */
	snapshot(): OrchestrationState {
		return this.state;
	}

	/** Restores everything to the initial state. */
	reset(): void {
		this.#state = {
			plan: { ...INITIAL_PLAN_STATE },
			goal: { ...INITIAL_GOAL_STATE },
			todo: { phases: [] },
		};
	}
}

/**
 * A one-line description of the plan state, for a status message.
 *
 * Names the state rather than inferring it, so "plan mode off" is never shown
 * while an approved plan is still attached — the specific confusion this module
 * exists to prevent.
 */
export function describePlanState(state: OrchestrationState): string {
	const { plan } = state;
	if (plan.phase === "planning") return "Planning in progress.";
	if (hasApprovedPlan(plan)) {
		const goal = state.goal.current ? ` Goal: ${state.goal.current.objective}.` : "";
		return `Approved plan "${plan.plan?.title}" is guiding implementation.${goal}`;
	}
	if (plan.unapproved && plan.plan) {
		return "An unapproved draft is attached; it is not implementation authority.";
	}
	if (plan.plan) return "A plan was superseded or rejected.";
	return "No active plan.";
}
