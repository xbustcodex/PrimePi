import { describe, expect, it } from "vitest";
import {
	BUDGET_STOP_FACTOR,
	BUDGET_STOP_GRACE_REQUESTS,
	budgetAction,
	budgetApplies,
	budgetStage,
	defaultWrapUpNotice,
	resolveSoftRequestBudget,
	SOFT_REQUEST_BUDGET,
} from "../src/core/task/budget.ts";

/**
 * Subagent request budgets.
 *
 * The property that matters most: **a bounded run still returns an answer.**
 * Crossing the budget injects a notice before anything is taken away, and the
 * hard abort is reachable only by an agent that ignored two chances to yield.
 */

const NOTICE = "wrap up and report what you found";

describe("budgets are ceilings, not fixed values", () => {
	it("takes the tighter of the configured value and the agent entry", () => {
		// The setting can lower a budget; it can never raise one above what the
		// agent's own definition allows.
		expect(resolveSoftRequestBudget("scout", 50)).toBe(50);
		expect(resolveSoftRequestBudget("scout", 5000)).toBe(SOFT_REQUEST_BUDGET.scout);
		// `default` has a bundled ceiling of its own, so a large configured value is
		// clamped to it rather than passing through.
		expect(resolveSoftRequestBudget("default", 5000)).toBe(SOFT_REQUEST_BUDGET.default);
		expect(resolveSoftRequestBudget("default", 150)).toBe(150);
	});

	it("uses the configured value for an agent with no bundled entry", () => {
		expect(resolveSoftRequestBudget("custom", 120)).toBe(120);
	});

	it("disables the guard at zero, whatever the bundled entry says", () => {
		// A guard a user cannot disable is not a setting.
		expect(resolveSoftRequestBudget("scout", 0)).toBe(0);
		expect(budgetApplies(0)).toBe(false);
	});

	it("normalises a fractional or negative configured value", () => {
		expect(resolveSoftRequestBudget("default", 150.7)).toBe(150);
		expect(resolveSoftRequestBudget("default", -5)).toBe(0);
	});
});

describe("the stages, and why each exists", () => {
	const state = (used: number, forcedYields = 0) => ({ budget: 100, used, forcedYields });
	const stopAt = Math.ceil(100 * BUDGET_STOP_FACTOR);

	it("does nothing under the budget", () => {
		// A run within its budget is working.
		expect(budgetStage(state(99))).toBe("within");
		const action = budgetAction(state(99), NOTICE);
		expect(action).toEqual({ stopTurn: false, forceYield: false, abort: false });
	});

	it("injects a notice when the budget is crossed, taking nothing away", () => {
		// The agent is told to finish, and can. This is the difference between a
		// soft budget and a limit.
		expect(budgetStage(state(100))).toBe("wrap-up");
		const action = budgetAction(state(100), NOTICE);
		expect(action.notice).toBe(NOTICE);
		expect(action.stopTurn).toBe(false);
		expect(action.abort).toBe(false);
	});

	it("stops the turn and forces one yield at 1.5x", () => {
		// Partial findings come back as a real report rather than being cut off.
		expect(budgetStage(state(stopAt))).toBe("forced-yield");
		const action = budgetAction(state(stopAt), NOTICE);
		expect(action.stopTurn).toBe(true);
		expect(action.forceYield).toBe(true);
		expect(action.abort).toBe(false);
	});

	it("hard-aborts only after a forced yield was already attempted", () => {
		// Reachable only by an agent that was told twice and kept going.
		expect(budgetStage(state(stopAt, 0))).toBe("forced-yield");
		expect(budgetStage(state(stopAt, 1))).toBe("exhausted");
		expect(budgetAction(state(stopAt, 1), NOTICE).abort).toBe(true);
	});

	it("allows grace requests after the stop before the yield can land", () => {
		// The forced yield needs room to arrive, or every long run aborts.
		expect(BUDGET_STOP_GRACE_REQUESTS).toBeGreaterThan(0);
		expect(budgetStage({ budget: 100, used: stopAt + 1, forcedYields: 0 })).toBe("forced-yield");
	});

	it("does nothing at all when the guard is off", () => {
		// A disabled budget must not produce a notice, a stop, or an abort.
		const state = { budget: 0, used: 100_000, forcedYields: 0 };
		expect(budgetStage(state)).toBe("within");
		expect(budgetAction(state, NOTICE)).toEqual({ stopTurn: false, forceYield: false, abort: false });
	});
});

describe("the notice", () => {
	it("names the budget and asks for a report of what was found", () => {
		const notice = defaultWrapUpNotice(100);
		expect(notice).toContain("100");
		// The point is a report, not an apology.
		expect(notice).toContain("report what you found");
	});

	it("asks for anything unfinished too", () => {
		// A run that stops without naming its gaps reads as a complete answer.
		expect(defaultWrapUpNotice(100)).toContain("unfinished");
	});
});
