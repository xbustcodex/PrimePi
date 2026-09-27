import { describe, expect, it } from "vitest";
import { AgentRegistry, isTerminalAgentState, narrowToolNames } from "../src/core/orchestration/agent-registry.ts";
import {
	DEFAULT_DELEGATION_BUDGETS,
	DelegationSemaphore,
	evaluateSpawn,
	RequestBudget,
} from "../src/core/orchestration/delegation-budgets.ts";
import { BUILT_IN_TOOL_TIERS, tierForTool } from "../src/core/security/tool-classification.ts";

/**
 * The registry and the delegation budgets.
 *
 * A child may only ever narrow its parent's capabilities, the lifecycle is closed
 * so a settled run cannot be resurrected, and every bound produces a typed
 * refusal rather than a hang.
 *
 * The engine that uses these — and the adversarial cases about the approval gate,
 * Plan Mode, and secrets — live with the task runner they exercise.
 */

describe("tool restriction: a child can only narrow", () => {
	it("drops any tool the parent does not have", () => {
		// OMP has no subset check at all; the trace found three ways a child
		// routinely ends up with more tools than its parent.
		expect(narrowToolNames(["read", "write"], ["read", "bash", "edit"])).toEqual(["read"]);
	});

	it("inherits the parent set when the child requests nothing", () => {
		expect(narrowToolNames(["read", "write"], undefined)).toEqual(["read", "write"]);
	});

	it("grants nothing for a child asking only for unavailable tools", () => {
		expect(narrowToolNames(["read"], ["bash", "write"])).toEqual([]);
	});

	it("keeps the Phase 3 classification for every granted tool", () => {
		// The tier travels with the tool, so a narrowed set is still gated.
		for (const name of runner0Tools()) {
			expect(BUILT_IN_TOOL_TIERS[name]).toBeDefined();
			expect(tierForTool({ name } as never)).toBeDefined();
		}
	});
});

function runner0Tools(): string[] {
	return Object.keys(BUILT_IN_TOOL_TIERS);
}

describe("the registry keeps a child identifiable and bounded", () => {
	it("assigns an opaque id that is never recycled", () => {
		const registry = new AgentRegistry();
		const first = registry.register({ name: "a", tools: [] });
		const second = registry.register({ name: "b", tools: [] });
		expect(first.id).not.toBe(second.id);
		// A stale id must never name a new child, so the counter only advances.
		const third = registry.register({ name: "c", tools: [] });
		expect(new Set([first.id, second.id, third.id]).size).toBe(3);
	});

	it("records parent identity and derives depth from it", () => {
		const registry = new AgentRegistry();
		const child = registry.register({ name: "a", tools: [] });
		expect(child.parentId).toBeUndefined();
		expect(child.depth).toBe(0);
	});

	it("refuses a transition out of a terminal state", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({ name: "a", tools: [] });
		expect(registry.markRunning(ref.id)).toBe(true);
		expect(registry.finish(ref.id, { state: "completed", reason: "completed", at: 1 })).toBe(true);
		// A late completion must not resurrect a settled child.
		expect(registry.markRunning(ref.id)).toBe(false);
		expect(registry.finish(ref.id, { state: "failed", reason: "child-error", at: 2 })).toBe(false);
		expect(registry.get(ref.id)?.state).toBe("completed");
	});

	it("records a result once and delivers it once", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({ name: "a", tools: [] });
		expect(registry.setResult(ref.id, "one")).toBe(true);
		expect(registry.setResult(ref.id, "two")).toBe(false);
		expect(registry.markDelivered(ref.id)).toBe(true);
		expect(registry.markDelivered(ref.id)).toBe(false);
		expect(registry.get(ref.id)?.result).toBe("one");
	});

	it("cancels descendants deepest-first so no parent outlives a child", () => {
		const registry = new AgentRegistry();
		const root = registry.register({ name: "root", tools: [] });
		const child = registry.register({ name: "child", tools: [], parentId: root.id });
		const grandchild = registry.register({ name: "gc", tools: [], parentId: child.id });

		const cancelled = registry.cancelDescendants(root.id);
		expect(cancelled).toEqual([grandchild.id, child.id]);
		expect(registry.get(child.id)?.state).toBe("cancelled");
	});

	it("refuses to forget a child that is still running", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({ name: "a", tools: [] });
		registry.markRunning(ref.id);
		expect(registry.forget(ref.id)).toBe(false);
	});

	it("recognizes every terminal state", () => {
		for (const state of ["completed", "failed", "cancelled", "timed-out", "rejected"] as const) {
			expect(isTerminalAgentState(state)).toBe(true);
		}
		expect(isTerminalAgentState("running")).toBe(false);
		expect(isTerminalAgentState("queued")).toBe(false);
	});
});

describe("delegation budgets bound execution", () => {
	it("refuses a spawn past the depth limit with a typed refusal", () => {
		expect(
			evaluateSpawn({ childDepth: 3, running: 0, budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 2 } }),
		).toEqual({
			kind: "depth",
			limit: 2,
			depth: 3,
		});
	});

	it("allows a spawn within the depth limit", () => {
		expect(
			evaluateSpawn({ childDepth: 1, running: 0, budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 2 } }),
		).toBeUndefined();
	});

	it("refuses a spawn past the concurrency limit", () => {
		expect(
			evaluateSpawn({ childDepth: 1, running: 2, budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxConcurrency: 2 } }),
		).toEqual({
			kind: "concurrency",
			limit: 2,
		});
	});

	it("treats a negative depth as unlimited", () => {
		expect(
			evaluateSpawn({ childDepth: 99, running: 0, budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: -1 } }),
		).toBeUndefined();
	});

	it("exhausts a request budget rather than running unbounded", () => {
		const budget = new RequestBudget(2);
		expect(budget.consume()).toBe(true);
		expect(budget.consume()).toBe(true);
		expect(budget.consume()).toBe(false);
		expect(budget.exhausted).toBe(true);
	});

	it("never hands out more permits than the limit", async () => {
		const sem = new DelegationSemaphore(2);
		const first = await sem.acquire();
		const second = await sem.acquire();
		expect(sem.available).toBe(false);
		expect(sem.tryAcquire()).toBeUndefined();
		first();
		second();
		expect(sem.available).toBe(true);
	});

	it("makes a double release inert rather than stealing a permit", async () => {
		const sem = new DelegationSemaphore(1);
		const release = await sem.acquire();
		release();
		release();
		expect(sem.held).toBe(0);
	});
});
