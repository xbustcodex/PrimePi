/**
 * Goal accounting: turns the session's cumulative token counters into usage
 * charged against the current goal.
 *
 * ## Traced from OMP
 *
 * OMP's `GoalRuntime` (`goals/runtime.ts`) interleaves two jobs in one class:
 * goal lifecycle (create / pause / resume / complete / drop) and usage
 * accounting. The lifecycle half belongs to state, so it lives in
 * `goal-state.ts` and is reached through the tool and `/goal`. The accounting
 * half is different: it needs a *baseline* and a *clock*, neither of which is
 * goal state, and it is the half that has to know when a turn starts.
 *
 * ## What this class is allowed to know
 *
 * Usage, a clock, and a way to read and write `GoalState`. Nothing about the
 * session, the filesystem, or a UI. That is what keeps the two invariants
 * checkable at a glance: this class writes only to `GoalState` (through the
 * host), so it cannot reach plan state, and it only ever transitions a goal to
 * `budget-limited` by charging accounted tokens to it.
 *
 * ## Why the baseline exists
 *
 * The host's counters are cumulative for the whole session, so the cost of one
 * turn is a *difference* against the value sampled when the turn began. Without
 * the baseline the first flush would charge every token the session has ever
 * billed to whichever goal happened to be active.
 *
 * ## Why wall-clock time is accounted at all
 *
 * `timeUsedSeconds` is part of `Goal`, so it is reported. It is derived from the
 * same accounting points as the tokens rather than from a timer, which is the
 * whole point of the module's rule that `budget-limited` is reached by *usage*.
 * Elapsed time alone never changes a goal's status.
 */

import {
	accountUsage,
	type Goal,
	type GoalState,
	goalTokenDelta,
	isAccountingStatus,
	type UsageLike,
} from "./goal-state.ts";

/** What the accounting needs from its owner. Injected so no session reference exists here. */
export interface GoalAccountingHost {
	/** The current goal state. Returned by value; mutate through `setState`. */
	getState(): GoalState;
	setState(state: GoalState): void;
	/** Cumulative token counters, monotonic across the session. */
	getCurrentUsage(): UsageLike;
	/** Milliseconds. Injectable so a test does not have to wait a second. */
	now?(): number;
}

/** What one accounting pass charged. Every field is zero when nothing was charged. */
export interface GoalAccountingResult {
	/** Tokens charged to the goal by this pass. */
	tokens: number;
	/** Whole seconds of wall clock charged by this pass. */
	wallSeconds: number;
	/** True only on the pass where accumulated usage reached the ceiling. */
	reachedBudgetLimit: boolean;
}

const NOTHING_ACCOUNTED: GoalAccountingResult = { tokens: 0, wallSeconds: 0, reachedBudgetLimit: false };

interface TurnBaseline {
	turnId: string;
	baseline: UsageLike;
	/** The goal this turn is charging, when one was active at turn start. */
	goalId?: string;
}

interface WallClock {
	lastAccountedAt: number;
	goalId?: string;
}

/**
 * Charges each turn's tokens to the goal that was active when it began.
 *
 * A goal that is created, paused, completed, or dropped mid-turn is not
 * retro-charged for work that happened before it existed: the baseline records
 * which goal a turn belongs to, and a flush only charges that goal.
 */
export class GoalAccounting {
	readonly #host: GoalAccountingHost;
	#turn: TurnBaseline | undefined;
	#wallClock: WallClock;

	constructor(host: GoalAccountingHost) {
		this.#host = host;
		this.#wallClock = { lastAccountedAt: this.#now() };
	}

	/**
	 * Samples the counters this turn will be measured against.
	 *
	 * Called from the session's `turn_start`, so "this turn" means the turn the
	 * model is running now rather than everything billed before it.
	 */
	onTurnStart(turnId: string, baselineUsage: UsageLike): void {
		const goal = this.#accountingGoal();
		this.#turn = { turnId, baseline: { ...baselineUsage }, goalId: goal?.id };
		if (goal && this.#wallClock.goalId !== goal.id) {
			this.#wallClock = { lastAccountedAt: this.#now(), goalId: goal.id };
		}
	}

	/**
	 * Charges usage accumulated since the last accounting point.
	 *
	 * Returns an all-zero result when there is nothing to charge: no goal, a goal
	 * in a status that does not consume budget, or a turn that started before the
	 * current goal existed.
	 */
	flush(): GoalAccountingResult {
		const goal = this.#accountingGoal();
		if (!goal) return NOTHING_ACCOUNTED;

		const chargesThisTurn = this.#turn?.goalId === goal.id;
		const chargesWallClock = this.#wallClock.goalId === goal.id;
		if (!chargesThisTurn && !chargesWallClock) return NOTHING_ACCOUNTED;

		const now = this.#now();
		const tokens = chargesThisTurn ? goalTokenDelta(this.#host.getCurrentUsage(), this.#turn!.baseline) : 0;
		const wallSeconds = chargesWallClock
			? Math.max(0, Math.floor((now - this.#wallClock.lastAccountedAt) / 1000))
			: 0;
		if (tokens <= 0 && wallSeconds <= 0) return NOTHING_ACCOUNTED;

		const next = accountUsage(this.#host.getState(), { tokens, wallSeconds, now });
		this.#host.setState(next);

		if (chargesThisTurn) this.#turn!.baseline = { ...this.#host.getCurrentUsage() };
		if (chargesWallClock && wallSeconds > 0) this.#wallClock.lastAccountedAt += wallSeconds * 1000;

		return {
			tokens,
			wallSeconds,
			reachedBudgetLimit: goal.status === "active" && next.current?.status === "budget-limited",
		};
	}

	/**
	 * Forgets every pending baseline.
	 *
	 * Used when the goal is dropped: a dropped goal is terminal, so carrying a
	 * baseline that could still charge it would let a later goal inherit it.
	 */
	clear(): void {
		this.#turn = undefined;
		this.#wallClock = { lastAccountedAt: this.#now() };
	}

	/** The goal id currently being charged, for callers that need to report progress. */
	get trackingGoalId(): string | undefined {
		return this.#accountingGoal()?.id;
	}

	#accountingGoal(): Goal | undefined {
		const goal = this.#host.getState().current;
		return goal && isAccountingStatus(goal.status) ? goal : undefined;
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}
}
