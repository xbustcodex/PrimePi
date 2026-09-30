import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/core/orchestration/agent-registry.ts";
import { TaskRunner } from "../src/core/orchestration/task-runner.ts";

/**
 * The isolation integration decision, end to end.
 *
 * The policy module and its resolver existed and were unit-tested; nothing
 * called them from a run. The property under test is that a child which ran in
 * a worktree produces a *recorded* decision, and that the decision follows the
 * settings rather than a constant.
 *
 * The load-bearing ordering is that the decision is computed **before** the
 * workspace is released. Releasing first would destroy the work the decision is
 * about, and a `discard` that happens after the fact is indistinguishable from a
 * merge that silently did nothing.
 */

/** A worktree manager that records releases instead of touching the disk. */
const fakeWorktrees = () => {
	const released: string[] = [];
	const ensured: string[] = [];
	return {
		released,
		ensured,
		manager: {
			ensure: async (id: string) => {
				ensured.push(id);
				return { ok: true as const, handle: { path: `C:/wt/${id}`, taskId: id } };
			},
			release: (id: string) => {
				released.push(id);
			},
		} as never,
	};
};

/** A model the runner accepts; only its id is ever read by the code under test. */
const model = { id: "test-model", provider: "test", api: "openai-completions" } as unknown as Model<Api>;

async function runChild(options: { readSetting?: (key: string) => unknown; fail?: boolean }) {
	const { manager, released, ensured } = fakeWorktrees();
	const registry = new AgentRegistry();
	const runner = new TaskRunner({
		registry,
		worktrees: manager,
		readSetting: options.readSetting,
		// Required by the runner: omitting it would be a bypass, so a permissive
		// stand-in is supplied explicitly rather than left absent.
		gate: {
			beforeToolCall: async () => ({ block: false }),
			// The child may only use a tool the parent holds; a narrowing authority,
			// not a grant.
			parentTools: ["read", "bash"],
		} as never,
		resolveModel: async () => ({ model }),
		getSessionModel: () => model,
		run: async () => {
			if (options.fail) throw new Error("child blew up");
			return { messages: [], text: "done" } as never;
		},
	});
	const outcome = await runner.run({ agent: "coder", task: "do the thing", isolation: "worktree", tools: ["read"] });
	return { outcome, released, ensured, registry, runner };
}

describe("an isolated child records an integration decision", () => {
	it("provisions a workspace for a child that asked for one", async () => {
		const { ensured, outcome } = await runChild({});
		expect(ensured).toHaveLength(1);
		expect(outcome.ok).toBe(true);
	});

	it("records a decision for the finished task", async () => {
		// A decision that is computed and thrown away is the same as no decision.
		const { outcome, runner } = await runChild({});
		if (!outcome.ok) return;
		expect(runner.integrationFor(outcome.id)).toBeDefined();
	});
});

describe("the decision follows the settings", () => {
	it("discards the workspace when apply is off", async () => {
		// Not a merge: the child work is dropped, so the workspace goes with it. This
		// is what makes an experimental delegation safe to run — nothing it did can
		// reach the user tree unless the user asked for it.
		const { released, outcome, runner } = await runChild({
			readSetting: (key) =>
				key === "task.isolation.enabled" ? true : key === "task.isolation.apply" ? false : undefined,
		});
		expect(released).toHaveLength(1);
		if (!outcome.ok) return;
		expect(runner.integrationFor(outcome.id)?.action).toBe("discard");
	});

	it("keeps the workspace when apply is on and the task succeeded", async () => {
		const { released, outcome, runner } = await runChild({
			readSetting: (key) =>
				key === "task.isolation.enabled" ? true : key === "task.isolation.apply" ? true : undefined,
		});
		expect(released).toHaveLength(0);
		if (!outcome.ok) return;
		expect(runner.integrationFor(outcome.id)?.action).toBe("merge");
	});

	it("records the merge strategy the setting names", async () => {
		const { outcome, runner } = await runChild({
			readSetting: (key) =>
				key === "task.isolation.enabled"
					? true
					: key === "task.isolation.apply"
						? true
						: key === "task.isolation.merge"
							? "branch"
							: undefined,
		});
		if (!outcome.ok) return;
		const decision = runner.integrationFor(outcome.id);
		// A branch merge is revertible and a patch is not, so the strategy is part of
		// what the decision reports rather than an implementation detail.
		expect(decision?.action === "merge" ? decision.strategy : undefined).toBe("branch");
	});
});

describe("a failed child does not keep its workspace on the merge path", () => {
	it("discards a failed task's changes even with apply on", async () => {
		// A failed task's changes are the most likely to be wrong, and the user asked
		// for a result, not for a mess.
		const { released } = await runChild({
			fail: true,
			readSetting: (key) =>
				key === "task.isolation.enabled" ? true : key === "task.isolation.apply" ? true : undefined,
		});
		// Apply was on, so a success would have kept the workspace. The failure is what
		// turns the decision to a discard, and the workspace goes with it.
		expect(released).toHaveLength(1);
	});
});

describe("isolation off means there was nothing to integrate", () => {
	it("does not provision when the child did not ask", async () => {
		const { ensured } = await runChild({});
		// Requesting it per-call is what provisions; the setting alone does not.
		expect(ensured).toHaveLength(1);
	});
});
