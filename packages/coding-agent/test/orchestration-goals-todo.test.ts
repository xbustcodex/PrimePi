import { describe, expect, it } from "vitest";
import {
	accountUsage,
	addGoal,
	dropGoal,
	goalStateFromRecord,
	goalTokenDelta,
	INITIAL_GOAL_STATE,
	isAccountingStatus,
	remainingTokens,
	resetGoalIdCounter,
	setGoalBudget,
} from "../src/core/orchestration/goal-state.ts";
import { describePlanState, Orchestration, planIndicator } from "../src/core/orchestration/orchestration.ts";
import {
	applyTodoOperation,
	INITIAL_TODO_STATE,
	openTaskCount,
	todoCounts,
	todoStateFromRecord,
} from "../src/core/orchestration/todo-state.ts";
import { BUILT_IN_TOOL_TIERS, tierForTool } from "../src/core/security/tool-classification.ts";

/**
 * Goals and TODO, plus the cross-cutting invariant that matters most:
 * a goal added during implementation must not disturb an approved plan.
 */

const T0 = 1_000_000;

describe("goals are structured state", () => {
	it("starts with no goal", () => {
		expect(INITIAL_GOAL_STATE.current).toBeUndefined();
	});

	it("stores an objective with a status and accounting fields", () => {
		resetGoalIdCounter();
		const state = addGoal(INITIAL_GOAL_STATE, { objective: "ship auth", now: T0 });
		expect(state.current?.objective).toBe("ship auth");
		expect(state.current?.status).toBe("active");
		expect(state.current?.tokensUsed).toBe(0);
		expect(state.current?.createdAt).toBe(T0);
	});

	it("reports remaining budget, and null when unbounded", () => {
		const unbounded = addGoal(INITIAL_GOAL_STATE, { objective: "a", now: T0 });
		expect(remainingTokens(unbounded.current)).toBeNull();

		const bounded = addGoal(INITIAL_GOAL_STATE, { objective: "b", tokenBudget: 100, now: T0 });
		const spent = accountUsage(bounded, { tokens: 40, wallSeconds: 1, now: T0 + 1 });
		expect(remainingTokens(spent.current)).toBe(60);
	});

	it("flips to budget-limited at the ceiling", () => {
		const state = addGoal(INITIAL_GOAL_STATE, { objective: "a", tokenBudget: 100, now: T0 });
		const spent = accountUsage(state, { tokens: 100, wallSeconds: 1, now: T0 + 1 });
		expect(spent.current?.status).toBe("budget-limited");
		expect(remainingTokens(spent.current)).toBe(0);
	});

	it("stops accounting once closed", () => {
		expect(isAccountingStatus("active")).toBe(true);
		expect(isAccountingStatus("budget-limited")).toBe(true);
		expect(isAccountingStatus("complete")).toBe(false);
		expect(isAccountingStatus("dropped")).toBe(false);

		const dropped = dropGoal(addGoal(INITIAL_GOAL_STATE, { objective: "a", now: T0 }), T0 + 1);
		const after = accountUsage(dropped, { tokens: 500, wallSeconds: 5, now: T0 + 2 });
		expect(after.current?.tokensUsed).toBe(0);
	});

	it("re-activates when the budget is raised", () => {
		const limited = accountUsage(addGoal(INITIAL_GOAL_STATE, { objective: "a", tokenBudget: 10, now: T0 }), {
			tokens: 10,
			wallSeconds: 1,
			now: T0 + 1,
		});
		expect(limited.current?.status).toBe("budget-limited");
		const raised = setGoalBudget(limited, 1000, T0 + 2);
		expect(raised.current?.status).toBe("active");
	});

	it("excludes cache reads from the delta and includes cache writes", () => {
		// OMP's deliberate divergence: a reused prefix is not new work, but
		// re-anchoring a system prompt can write a very large number of tokens.
		const baseline = { input: 100, output: 50, cacheRead: 900, cacheWrite: 10 };
		const current = { input: 110, output: 55, cacheRead: 95_000, cacheWrite: 5_000 };

		// +10 input, +5 output, +4990 cacheWrite; cacheRead's 94k is excluded.
		expect(goalTokenDelta(current, baseline)).toBe(10 + 5 + 4_990);

		// Each term is clamped independently, so a counter that goes backwards
		// contributes zero rather than a negative that would refund the budget.
		expect(goalTokenDelta({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, baseline)).toBe(0);
	});

	it("accounts a precomputed delta into the goal", () => {
		const state = addGoal(INITIAL_GOAL_STATE, { objective: "a", tokenBudget: 1000, now: T0 });
		const spent = accountUsage(state, { tokens: 250, wallSeconds: 3, now: T0 + 1 });
		expect(spent.current?.tokensUsed).toBe(250);
		expect(spent.current?.timeUsedSeconds).toBe(3);
	});

	it("rejects a corrupt record rather than trusting it", () => {
		expect(goalStateFromRecord({ current: { objective: 5 } }).current).toBeUndefined();
		expect(goalStateFromRecord({ current: { objective: "a", status: "nonsense" } }).current).toBeUndefined();
		expect(goalStateFromRecord(undefined).current).toBeUndefined();
	});
});

describe("todo lifecycle", () => {
	function init() {
		return applyTodoOperation(INITIAL_TODO_STATE, "init", {
			list: [
				{ phase: "Build", items: ["write schema", "add tests"] },
				{ phase: "Ship", items: ["tag release"] },
			],
		});
	}

	it("creates phases with exactly one task in progress", () => {
		const { state } = init();
		expect(state.phases).toHaveLength(2);
		const active = state.phases.flatMap((p) => p.tasks).filter((t) => t.status === "in_progress");
		expect(active).toHaveLength(1);
		expect(active[0]?.content).toBe("write schema");
	});

	it("demotes the previous active task when another starts", () => {
		const { state } = init();
		const { state: next } = applyTodoOperation(state, "start", { task: "add tests" });
		const active = next.phases.flatMap((p) => p.tasks).filter((t) => t.status === "in_progress");
		expect(active).toHaveLength(1);
		expect(active[0]?.content).toBe("add tests");
	});

	it("rejects an unknown task rather than silently doing nothing", () => {
		const { state } = init();
		const { state: next, error } = applyTodoOperation(state, "done", { task: "nonexistent" });
		expect(error).toMatch(/not found/);
		// The list is untouched: a batch with an error is discarded wholesale.
		expect(next).toBe(state);
	});

	it("refuses to reopen completed work", () => {
		const { state } = init();
		const done = applyTodoOperation(state, "done", { task: "write schema" }).state;
		const reopened = applyTodoOperation(done, "start", { task: "write schema" });
		expect(reopened.error).toMatch(/completed/);
	});

	it("blocks and unblocks with a normalized reason", () => {
		const { state } = init();
		const blocked = applyTodoOperation(state, "block", { task: "add tests", reason: "waiting\non   review" }).state;
		const task = blocked.phases[0]?.tasks.find((t) => t.content === "add tests");
		expect(task?.status).toBe("blocked");
		expect(task?.blocker).toBe("waiting on review");

		const unblocked = applyTodoOperation(blocked, "unblock", { task: "add tests" }).state;
		expect(unblocked.phases[0]?.tasks.find((t) => t.content === "add tests")?.blocker).toBeUndefined();
	});

	it("rejects duplicate content, which would be unaddressable", () => {
		const { error } = applyTodoOperation(INITIAL_TODO_STATE, "init", { list: [{ phase: "P", items: ["a", "a"] }] });
		expect(error).toMatch(/Duplicate task content/);
	});

	it("treats view as a pure read that cannot mutate", () => {
		const { state } = init();
		const viewed = applyTodoOperation(state, "view", {});
		expect(viewed.error).toBeUndefined();
		// Viewing must not promote a task as a side effect.
		expect(viewed.state).toBe(state);
	});

	it("counts open work", () => {
		const { state } = init();
		const withDone = applyTodoOperation(state, "done", { task: "write schema" }).state;
		expect(openTaskCount(withDone)).toBe(2);
		expect(todoCounts(withDone).completed).toBe(1);
	});

	it("round-trips through a record and renormalizes on load", () => {
		const { state } = init();
		// Forge a snapshot with two active tasks, as a hand-edited journal could.
		const forged = {
			phases: [
				{
					name: "P",
					tasks: [
						{ content: "a", status: "in_progress" },
						{ content: "b", status: "in_progress" },
					],
				},
			],
		};
		const restored = todoStateFromRecord(forged);
		expect(restored.phases[0]?.tasks.filter((t) => t.status === "in_progress")).toHaveLength(1);
		expect(restored).toBeTruthy();
		expect(state.phases).toHaveLength(2);
	});

	it("rejects a corrupt record", () => {
		expect(todoStateFromRecord({ phases: "nope" }).phases).toEqual([]);
		expect(todoStateFromRecord(undefined).phases).toEqual([]);
	});
});

describe("todo is classified write-class", () => {
	it("joins the tool classification table as write", () => {
		expect(BUILT_IN_TOOL_TIERS.todo).toBe("write");
		expect(tierForTool({ name: "todo" } as never)).toBe("write");
	});

	it("is not exec, which would make progress tracking unusable", () => {
		expect(tierForTool({ name: "todo" } as never)).not.toBe("exec");
	});
});

describe("THE invariant: a goal never mutates an approved plan", () => {
	function approvedSession() {
		const o = new Orchestration();
		o.beginPlanning(T0);
		o.recordDraft({ title: "Add auth", content: "# Plan", now: T0 + 10 });
		o.approvePlan(T0 + 20);
		return o;
	}

	it("keeps the plan identical when a goal is added mid-implementation", () => {
		const o = approvedSession();
		const planBefore = o.plan;

		o.addGoal({ objective: "also fix the flaky test", now: T0 + 30 });

		expect(o.plan).toEqual(planBefore);
		expect(o.hasApprovedPlan).toBe(true);
		expect(o.plan.plan?.content).toBe("# Plan");
	});

	it("reports both an approved plan and a goal together", () => {
		const o = approvedSession();
		o.addGoal({ objective: "fix flaky test", now: T0 + 30 });

		expect(planIndicator(o.state)).toBe("APPROVED PLAN GUIDING IMPLEMENTATION");
		expect(describePlanState(o.state)).toContain("guiding implementation");
		expect(describePlanState(o.state)).toContain("fix flaky test");
	});

	it("keeps the todo list independent of both", () => {
		const o = approvedSession();
		o.setTodo({ phases: [{ name: "P", tasks: [{ content: "x", status: "in_progress" }] }] });
		const before = o.plan;

		o.addGoal({ objective: "another", now: T0 + 40 });
		expect(o.plan).toEqual(before);
		expect(o.todo.phases[0]?.tasks[0]?.content).toBe("x");
	});

	it("restores all three subsystems independently from a record", () => {
		const o = approvedSession();
		o.addGoal({ objective: "goal text", now: T0 + 30 });
		o.setTodo({ phases: [{ name: "P", tasks: [{ content: "t", status: "in_progress" }] }] });

		const restored = new Orchestration();
		// A record with a corrupt todo must not discard a valid plan and goal.
		restored.restore({ plan: o.snapshot().plan, goal: o.snapshot().goal, todo: "garbage" });

		expect(restored.hasApprovedPlan).toBe(true);
		expect(restored.goal.current?.objective).toBe("goal text");
		expect(restored.todo.phases).toEqual([]);
	});
});

describe("plan indicators are distinguishable", () => {
	it("distinguishes active planning from an approved plan and from no plan", () => {
		const planning = new Orchestration();
		planning.beginPlanning(T0);
		expect(planIndicator(planning.state)).toBe("PLAN MODE ACTIVE");

		const approved = new Orchestration();
		approved.beginPlanning(T0);
		approved.recordDraft({ title: "t", content: "c", now: T0 + 1 });
		approved.approvePlan(T0 + 2);
		// Plan mode off, plan still attached.
		approved.leavePlanning(T0 + 3);
		expect(planIndicator(approved.state)).toBe("APPROVED PLAN GUIDING IMPLEMENTATION");

		const none = new Orchestration();
		expect(planIndicator(none.state)).toBe("NO ACTIVE PLAN");
	});

	it("never reports PLAN MODE ACTIVE merely because a plan is attached", () => {
		const o = new Orchestration();
		o.beginPlanning(T0);
		o.recordDraft({ title: "t", content: "c", now: T0 + 1 });
		// Disabling before approval leaves a draft attached.
		o.leavePlanning(T0 + 2);
		expect(o.plan.plan).toBeDefined();
		expect(planIndicator(o.state)).toBe("NO ACTIVE PLAN");
		expect(describePlanState(o.state)).toMatch(/not implementation authority/);
	});
});
