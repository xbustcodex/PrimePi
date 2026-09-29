/**
 * Subagent request budgets: bounding a delegated run without losing its findings.
 *
 * ## Why soft before hard
 *
 * A subagent that has run for a long time has usually *found* something. Killing
 * it at the budget discards that. So crossing the budget does not stop the run —
 * it **injects a wrap-up notice**, and the agent gets a chance to stop on its own
 * terms and report what it has.
 *
 * Only at 1.5x the budget is the free-running turn stopped, and even then the
 * agent is driven to one forced final `yield` so partial findings come back as a
 * real report. A run is hard-aborted only if it still refuses to yield within a
 * short grace period after that.
 *
 * That sequence is the whole point: **a bounded run still returns an answer**,
 * rather than being cut off mid-thought.
 *
 * ## Budgets are ceilings, not fixed values
 *
 * An agent's bundled entry is a ceiling and the configured setting is a ceiling,
 * and **the tighter one wins**. The setting can lower a budget; it can never
 * raise one above what the agent's own definition allows. A configuration
 * screen that could raise `scout` above its designed cap would be a way to run a
 * subagent in a mode nobody tested.
 *
 * `0` disables the guard entirely, regardless of the bundled entry — a user who
 * turns it off means it, and a guard they cannot disable is not a setting.
 *
 * ## The stages, and why each exists
 *
 * - **under budget** — nothing. A run that is within its budget is working.
 * - **over budget** — a wrap-up notice. The agent is told to finish, and can.
 * - **over 1.5x** — the turn is stopped and one final `yield` is forced, so the
 *   findings land as a report.
 * - **still yielding after the grace** — hard abort. The last resort, and
 *   reachable only by an agent that has been told twice.
 */

/** Extra requests allowed after a budget stop, so the forced yield can land. */
export const BUDGET_STOP_GRACE_REQUESTS = 3;

/** The multiple of the budget at which the turn is stopped. */
export const BUDGET_STOP_FACTOR = 1.5;

/**
 * Bundled per-agent ceilings.
 *
 * A record rather than a map: these are static, and a `Map` here would suggest
 * runtime insertion that does not happen.
 */
export const SOFT_REQUEST_BUDGET: Readonly<Record<string, number>> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

/**
 * The effective budget for an agent.
 *
 * Both the configured value and the bundled entry are ceilings, so the tighter
 * one wins. A configured `0` disables the guard regardless of the entry.
 */
export function resolveSoftRequestBudget(agentName: string, configuredBudget: number): number {
	const configured = Math.max(0, Math.trunc(configuredBudget));
	if (configured === 0) return 0;
	const bundled = SOFT_REQUEST_BUDGET[agentName] ?? configured;
	// The setting can lower a budget but never raise one above what the agent's
	// own definition allows, so a configuration screen cannot put a subagent into
	// a mode nobody tested.
	return Math.min(configured, bundled);
}

/** Where a run has reached in its budget. */
export type BudgetStage = "within" | "wrap-up" | "forced-yield" | "exhausted";

export interface BudgetState {
	/** The effective budget; `0` means the guard is off. */
	readonly budget: number;
	/** Assistant requests made so far. */
	readonly used: number;
	/** How many forced-yield attempts have already been made. */
	readonly forcedYields: number;
}

/** Whether the guard applies at all. */
export function budgetApplies(budget: number): boolean {
	return budget > 0;
}

/** The stage a run has reached. */
export function budgetStage(state: BudgetState): BudgetStage {
	if (!budgetApplies(state.budget)) return "within";
	if (state.used < state.budget) return "within";
	// Past the stop point, the agent gets the grace requests to land its yield.
	if (state.used >= Math.ceil(state.budget * BUDGET_STOP_FACTOR)) {
		return state.forcedYields > 0 ? "exhausted" : "forced-yield";
	}
	return "wrap-up";
}

/** What a caller should do at this stage. */
export interface BudgetAction {
	/** The steering notice to inject, when one is due. */
	readonly notice?: string;
	/** Whether to stop the free-running turn. */
	readonly stopTurn: boolean;
	/** Whether the agent must produce a final yield. */
	readonly forceYield: boolean;
	/** Whether to abort the run outright. */
	readonly abort: boolean;
}

/**
 * The action for the current state.
 *
 * Separate from {@link budgetStage} so a caller can report the stage without
 * acting on it, and so a notice can be produced without a transition.
 */
export function budgetAction(state: BudgetState, noticeText: string): BudgetAction {
	const stage = budgetStage(state);
	switch (stage) {
		case "within":
			return { stopTurn: false, forceYield: false, abort: false };
		case "wrap-up":
			// The agent is told to finish, and can. Nothing is taken from it.
			return { notice: noticeText, stopTurn: false, forceYield: false, abort: false };
		case "forced-yield":
			// The turn is stopped and one final yield is driven, so partial findings
			// come back as a real report rather than being cut off.
			return { notice: noticeText, stopTurn: true, forceYield: true, abort: false };
		case "exhausted":
			// Reachable only by an agent that was told to yield and did not.
			return { stopTurn: true, forceYield: false, abort: true };
	}
}

/** The default wrap-up notice, so the rule and its wording cannot drift apart. */
export function defaultWrapUpNotice(budget: number): string {
	return `You have used all ${budget} of your request budget. Stop investigating and report what you found so far, including anything unfinished.`;
}
