/**
 * Goals: structured session state with a token budget.
 *
 * ## Traced from OMP
 *
 * OMP's `Goal` (`packages/tui/src/tools/goal.ts:12-21`) is structured state, not
 * prompt text:
 *
 * ```ts
 * interface Goal {
 *   id: string; objective: string; status: GoalStatus;
 *   tokenBudget?: number; tokensUsed: number; timeUsedSeconds: number;
 *   createdAt: number; updatedAt: number;
 * }
 * type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";
 * ```
 *
 * The prompt text is a *rendering* of that state
 * (`renderGoalPrompt`, `goals/runtime.ts:80-94`), which is why the two are kept
 * apart here too: state is authoritative, text is derived.
 *
 * ## The relationship to plans, which the trace found surprising
 *
 * The `GoalsTrace` report is explicit: `grep "plan|planFilePath|planReferencePath"`
 * over OMP's `goals/` returns **zero** matches. Goals and plans are strictly
 * mutually exclusive *modes* with zero data coupling — `#enterPlanMode` refuses
 * while goal mode is active, and `#enterGoalMode` refuses while plan mode is
 * active. Sequencing, not data.
 *
 * This port keeps that separation but relaxes the mutual exclusion, because the
 * requirement here is explicitly to support "additional goals during
 * implementation without silently rewriting the approved plan". The
 * consequence to preserve is the important one: a goal never mutates a plan. So
 * `addGoal` is additive and `PlanState` is untouched by anything in this file.
 */

/** Goal lifecycle status, matching OMP's `GoalStatus` exactly. */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** One goal. Field names mirror OMP so a ported mental model still applies. */
export interface Goal {
	/** Stable identifier, unique within a session. */
	id: string;
	/** What the user asked for, verbatim. */
	objective: string;
	status: GoalStatus;
	/** Optional ceiling. Absent means unbounded, not zero. */
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalState {
	/**
	 * The current goal, or undefined when none is set.
	 *
	 * A single active goal rather than a list, matching OMP. Additional goals
	 * *replace* the current one through `replaceGoal`; the superseded objective
	 * is not retained, because OMP does not retain it either and a stale list
	 * would imply history OMP does not keep.
	 */
	current?: Goal;
}

export const INITIAL_GOAL_STATE: GoalState = {};

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

/** True when a goal is still consuming budget. Matches OMP's `isAccountingStatus`. */
export function isAccountingStatus(status: GoalStatus): boolean {
	return status === "active" || status === "budget-limited";
}

/** Tokens left, or null when unbounded. Matches OMP's `remainingTokens`. */
export function remainingTokens(goal: Goal | undefined): number | null {
	if (!goal || goal.tokenBudget === undefined) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

/**
 * Token delta for a turn.
 *
 * Reproduces OMP's deliberate divergence (`goals/runtime.ts:66-77`): `cacheRead`
 * is excluded because a reused prefix is not new work, while `cacheWrite` is
 * included because re-anchoring a system prompt can write a very large number of
 * tokens for very little work. Each term is clamped independently so a counter
 * that goes backwards contributes zero rather than a negative.
 */
export function goalTokenDelta(current: UsageLike, baseline: UsageLike): number {
	return (
		Math.max(0, current.input - baseline.input) +
		Math.max(0, current.cacheWrite - baseline.cacheWrite) +
		Math.max(0, current.output - baseline.output)
	);
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

let goalCounter = 0;

function nextGoalId(): string {
	goalCounter += 1;
	return `goal-${goalCounter}`;
}

/** Test seam for deterministic ids. */
export function resetGoalIdCounter(): void {
	goalCounter = 0;
}

/**
 * Creates a goal, replacing any current one.
 *
 * Replacing rather than refusing matches OMP's `createGoal`, which throws only
 * when an existing goal is neither dropped nor complete, and `replaceGoal`,
 * which requires an active goal. Folding both into one additive operation is
 * what lets a user add work during implementation without the plan noticing.
 */
export function addGoal(_state: GoalState, input: { objective: string; tokenBudget?: number; now: number }): GoalState {
	return {
		current: {
			id: nextGoalId(),
			objective: input.objective,
			status: "active",
			tokenBudget: input.tokenBudget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: input.now,
			updatedAt: input.now,
		},
	};
}

/** Accounts a turn against the current goal, flipping to budget-limited at the ceiling. */
export function accountUsage(state: GoalState, delta: { tokens: number; wallSeconds: number; now: number }): GoalState {
	const goal = state.current;
	if (!goal || !isAccountingStatus(goal.status)) return state;

	const tokensUsed = goal.tokensUsed + Math.max(0, delta.tokens);
	const exhausted = goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget;

	return {
		current: {
			...goal,
			tokensUsed,
			timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, delta.wallSeconds),
			status: exhausted ? "budget-limited" : goal.status,
			updatedAt: delta.now,
		},
	};
}

export function setGoalStatus(state: GoalState, status: GoalStatus, now: number): GoalState {
	if (!state.current) return state;
	return { current: { ...state.current, status, updatedAt: now } };
}

/** Adjusts the budget, re-evaluating the budget-limited status in both directions. */
export function setGoalBudget(state: GoalState, tokenBudget: number | undefined, now: number): GoalState {
	const goal = state.current;
	if (!goal) return state;
	const tokensUsed = goal.tokensUsed;
	const exhausted = tokenBudget !== undefined && tokensUsed >= tokenBudget;
	return {
		current: {
			...goal,
			tokenBudget,
			// Raising a budget above usage re-activates a goal that was
			// budget-limited, matching OMP's `onBudgetMutated`.
			status: exhausted ? "budget-limited" : goal.status === "budget-limited" ? "active" : goal.status,
			updatedAt: now,
		},
	};
}

/** Removes the goal entirely. */
export function dropGoal(state: GoalState, now: number): GoalState {
	if (!state.current) return state;
	return { current: { ...state.current, status: "dropped", updatedAt: now } };
}

export function clearGoal(_state: GoalState): GoalState {
	return { ...INITIAL_GOAL_STATE };
}

export function goalStateFromRecord(record: unknown): GoalState {
	if (!record || typeof record !== "object") return { ...INITIAL_GOAL_STATE };
	const candidate = (record as { current?: unknown }).current;
	if (!candidate || typeof candidate !== "object") return { ...INITIAL_GOAL_STATE };

	const goal = candidate as Partial<Goal>;
	if (typeof goal.objective !== "string" || typeof goal.status !== "string") return { ...INITIAL_GOAL_STATE };

	const statuses: readonly GoalStatus[] = ["active", "paused", "budget-limited", "complete", "dropped"];
	if (!statuses.includes(goal.status as GoalStatus)) return { ...INITIAL_GOAL_STATE };

	return {
		current: {
			id: typeof goal.id === "string" ? goal.id : "goal-restored",
			objective: goal.objective,
			status: goal.status as GoalStatus,
			tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined,
			tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
			timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
			createdAt: typeof goal.createdAt === "number" ? goal.createdAt : 0,
			updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
		},
	};
}

export function snapshotGoalState(state: GoalState): GoalState {
	return state.current ? { current: cloneGoal(state.current) } : { ...INITIAL_GOAL_STATE };
}
