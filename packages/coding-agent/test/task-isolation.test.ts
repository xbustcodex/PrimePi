import { describe, expect, it } from "vitest";
import {
	DEFAULT_ISOLATION,
	decideIntegration,
	describeIsolation,
	describeMergeCost,
	type IsolationSettings,
	planWorktreePath,
	requiresNoFastForward,
} from "../src/core/task/isolation.ts";

/**
 * Worktree isolation.
 *
 * The property that makes an experimental delegation safe: with `apply` off, a
 * finished task's changes are **discarded rather than merged**, so running
 * something speculative cannot surprise the user with a dirty tree.
 */

const settings = (overrides: Partial<IsolationSettings> = {}): IsolationSettings => ({
	...DEFAULT_ISOLATION,
	enabled: true,
	...overrides,
});

describe("integrating a finished task", () => {
	it("discards the changes when apply is off", () => {
		// What makes an experimental delegation safe to run.
		const decision = decideIntegration(settings({ apply: false }), { taskSucceeded: true });
		expect(decision.action).toBe("discard");
		expect(decision.reason).toContain("leaves the working tree untouched");
	});

	it("merges with the configured strategy when apply is on", () => {
		const decision = decideIntegration(settings({ apply: true, merge: "patch" }), { taskSucceeded: true });
		expect(decision.action).toBe("merge");
		if (decision.action !== "merge") return;
		expect(decision.strategy).toBe("patch");
	});

	it("discards a failed task even when apply is on", () => {
		// A failed task's changes are the most likely to be wrong, and the user asked
		// for a result, not for a mess.
		const decision = decideIntegration(settings({ apply: true }), { taskSucceeded: false });
		expect(decision.action).toBe("discard");
		expect(decision.reason).toContain("failed");
	});

	it("does not pretend to discard when isolation was never on", () => {
		// The task wrote straight into the user's tree, so there is nothing to
		// integrate and nothing to discard.
		const decision = decideIntegration(settings({ enabled: false, apply: false }), { taskSucceeded: true });
		expect(decision.action).toBe("merge");
		if (decision.action !== "merge") return;
		expect(decision.reason).toContain("worked in place");
	});
});

describe("the two strategies are not equivalent", () => {
	it("patch commits nothing, so a wrong result is free to undo", () => {
		expect(describeMergeCost("patch")).toContain("discarded with git checkout");
	});

	it("branch commits, so a wrong result costs a revert", () => {
		expect(describeMergeCost("branch")).toContain("costs a revert");
	});

	it("requires --no-ff for a branch merge, and says why", () => {
		// A fast-forward merge leaves no commit to revert *to*: the branch pointer
		// simply moves. The merge commit is what makes the pre-merge state
		// addressable at all.
		expect(requiresNoFastForward()).toBe(true);
		expect(decideIntegration(settings({ apply: true, merge: "branch" }), { taskSucceeded: true })).toMatchObject({
			action: "merge",
			strategy: "branch",
		});
	});
});

describe("worktree paths are derived, not invented", () => {
	it("gives two delegations of one task distinct directories", () => {
		// A collision is how one task's uncommitted changes end up in another's
		// review.
		const base = "/repo/.worktrees";
		const first = planWorktreePath({ base, taskId: "task-1", cwd: "/repo" });
		const second = planWorktreePath({ base, taskId: "task-2", cwd: "/repo" });
		expect(first.path).not.toBe(second.path);
	});

	it("sanitises a task id that reaches a filesystem path", () => {
		// A separator in the id would place the worktree somewhere the user did not
		// choose.
		const plan = planWorktreePath({ base: "/repo/.worktrees", taskId: "../../etc", cwd: "/repo" });
		expect(plan.path).toBe("/repo/.worktrees/..-..-etc");
	});

	it("falls back to a usable name when the id has nothing safe in it", () => {
		expect(planWorktreePath({ base: "/w", taskId: "!!!", cwd: "/repo" }).path).toBe("/w/---");
		expect(planWorktreePath({ base: "/w", taskId: "", cwd: "/repo" }).path).toBe("/w/task");
	});

	it("does not double the separator on the base", () => {
		expect(planWorktreePath({ base: "/repo/wt/", taskId: "t", cwd: "/repo" }).path).toBe("/repo/wt/t");
	});

	it("records the base checkout it was derived from", () => {
		expect(planWorktreePath({ base: "/w", taskId: "t", cwd: "/repo" }).base).toBe("/repo");
	});
});

describe("isolation is not a sandbox", () => {
	it("says so plainly", () => {
		// A worktree shares the object store, hooks and credentials. Treating it as
		// a sandbox is the failure this exists to prevent.
		expect(describeIsolation()).toContain("not a sandbox");
		expect(describeIsolation()).toContain("credentials");
	});
});
