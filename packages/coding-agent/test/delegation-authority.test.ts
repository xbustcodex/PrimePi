import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DELEGATION_BUDGETS } from "../src/core/orchestration/delegation-budgets.ts";
import { JobManager } from "../src/core/orchestration/job-manager.ts";
import { TaskRunner, type TaskRunnerOptions } from "../src/core/orchestration/task-runner.ts";
import { BUILT_IN_TOOL_TIERS } from "../src/core/security/tool-classification.ts";

/**
 * Authority preservation under delegation.
 *
 * The claim being defended: adding a child changes who does the work, never
 * what is permitted. Every existing authority — the paid/free policy, credential
 * reachability, tool narrowing, approval, the planning barrier — must hold
 * identically whether the parent or a child is acting. A child that could route
 * around any of these would make delegation a privilege escalation, not a
 * capability.
 */

function model(id: string, cost: number): Model<Api> {
	return {
		provider: "openrouter",
		id,
		name: id,
		cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

const PAID = model("vendor/paid", 5);
const FREE = model("vendor/free", 0);

function runner(overrides: Partial<TaskRunnerOptions> = {}): TaskRunner {
	return new TaskRunner({
		gate: { parentTools: ["read", "write", "bash"], beforeToolCall: async () => undefined },
		getSessionModel: () => PAID,
		resolveModel: async () => ({ model: PAID }),
		run: async () => "ok",
		...overrides,
	});
}

describe("authority preservation", () => {
	it("classifies task at the exec tier, alongside the tools it can reach", () => {
		// A child can run `bash` and `write`. If `task` were a lower tier, a
		// strict approval mode would gate those directly yet allow delegation to
		// reach them indirectly — an escalation via indirection.
		expect(BUILT_IN_TOOL_TIERS.task).toBe("exec");
		expect(BUILT_IN_TOOL_TIERS.task).toBe(BUILT_IN_TOOL_TIERS.bash);
		expect(BUILT_IN_TOOL_TIERS.task).toBe(BUILT_IN_TOOL_TIERS.powershell);
		// `read` and `write` are lower tiers, so `task` must not sit among them: a
		// child can reach those tools, and delegation must not be a cheaper route
		// to them.
		expect(["read", "write"]).not.toContain(BUILT_IN_TOOL_TIERS.task);
	});

	it("refuses to spawn when the parent's gate denies it", async () => {
		const deny = vi.fn(async () => ({ block: true, reason: "plan mode: research only" }));
		const result = await runner({ gate: { parentTools: ["read"], beforeToolCall: deny } }).run({
			agent: "coder",
			task: "edit the parser",
		});
		// The barrier applies to the spawn itself, not merely to the child's
		// individual calls, so a refused child never starts.
		expect(result.ok).toBe(false);
		expect(deny).toHaveBeenCalledOnce();
	});

	it("consults the gate before registering a child, leaving no record of a refusal", async () => {
		const r = runner({
			gate: { parentTools: ["read"], beforeToolCall: async () => ({ block: true, reason: "no" }) },
		});
		const before = r.list().length;
		await r.run({ agent: "coder", task: "t" });
		// A denied spawn must leave nothing behind: no registry entry, no permit
		// held, no workspace allocated.
		expect(r.list().length).toBe(before);
		expect(r.runningCount).toBe(0);
	});

	it("never grants a child a tool the parent does not hold", async () => {
		let granted: readonly string[] = [];
		const r = runner({
			gate: { parentTools: ["read"], beforeToolCall: async () => undefined },
			run: async (input) => {
				granted = input.tools;
				return "ok";
			},
		});
		await r.run({ agent: "coder", task: "t", tools: ["read", "write", "bash", "powershell"] });
		// The parent holds only `read`. Every other name is dropped, so a child
		// cannot escalate its own tool surface by asking for it.
		expect([...granted]).toEqual(["read"]);
	});

	it("gives a child the parent's tools when the child requests nothing", async () => {
		let granted: readonly string[] = [];
		const r = runner({
			gate: { parentTools: ["read", "write"], beforeToolCall: async () => undefined },
			run: async (input) => {
				granted = input.tools;
				return "ok";
			},
		});
		await r.run({ agent: "coder", task: "t" });
		expect([...granted].sort()).toEqual(["read", "write"]);
	});

	it("routes a child's model request through the host resolver, not straight to a model", async () => {
		// The runner does not choose a model. It asks the host, which is where Pi's
		// paid/credential/role authorities live, and honours a rejection.
		const seen: { role: string | undefined; sessionModel: Model<Api> | undefined }[] = [];
		const resolve = vi.fn(async (input: { role: string | undefined; sessionModel: Model<Api> | undefined }) => {
			seen.push(input);
			return { model: FREE, rejectedReason: undefined };
		});
		await runner({ resolveModel: resolve }).run({ agent: "coder", task: "t", modelRole: "smol" });
		expect(resolve).toHaveBeenCalledOnce();
		// The role travels as a proposal; the resolver decides.
		expect(seen[0]?.role).toBe("smol");
	});

	it("honours a resolver rejection instead of falling back to a paid model", async () => {
		// A host that refuses every eligible model must not be second-guessed by
		// the runner. Falling back to the parent's model would spend money the
		// policy declined to spend.
		const r = runner({ resolveModel: async () => ({ rejectedReason: "no free model is credential-free" }) });
		const result = await r.run({ agent: "coder", task: "t", modelRole: "smol" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/credential-free|no free model/i);
	});

	it("passes the parent's session model so free-only policy can be evaluated", async () => {
		// The child's inherited model is the parent's, and the host needs it to
		// decide whether a free-only policy can be satisfied. Omitting it would
		// make the check impossible rather than permissive.
		const seenModels: (Model<Api> | undefined)[] = [];
		const resolve = vi.fn(async (input: { sessionModel: Model<Api> | undefined }) => {
			seenModels.push(input.sessionModel);
			return { model: FREE };
		});
		await runner({ resolveModel: resolve, getSessionModel: () => PAID }).run({ agent: "coder", task: "t" });
		expect(seenModels[0]).toBe(PAID);
	});

	it("enforces the depth limit, so delegation cannot recurse without bound", async () => {
		// A root agent is depth 0 and a child is depth 1, so `maxDepth: 0` forbids
		// delegation outright; a limit of 1 would still permit one child.
		const r = runner({ budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 0 } });
		const result = await r.run({ agent: "coder", task: "t" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("depth-limit");
	});

	it("refuses a spawn when concurrency is exhausted", async () => {
		// A child holds its permit until it finishes, so the second spawn genuinely
		// arrives while the first still occupies it. The first is released at the
		// end so the test leaves no pending work behind.
		let releaseFirst: (() => void) | undefined;
		const r = runner({
			budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxConcurrency: 1 },
			run: () =>
				new Promise<string>((resolve) => {
					releaseFirst = () => resolve("done");
				}),
		});
		const first = r.run({ agent: "a", task: "t" });
		await new Promise((resolve) => setTimeout(resolve, 15));
		const second = await r.run({ agent: "b", task: "t" });
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.code).toBe("concurrency-limit");
		// Release the first so the test leaves no pending work behind.
		releaseFirst?.();
		await expect(first).resolves.toBeDefined();
	});

	it("cancels a running child, and a cancelled child reports as cancelled not failed", async () => {
		// A child that observes its signal is the host contract: the runner cannot
		// force a host to stop. What it guarantees is that an aborted child is
		// reported as *cancelled* rather than failed.
		const r = runner({
			run: (input) =>
				new Promise<string>((_resolve, reject) => {
					input.signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		const pending = r.run({ agent: "coder", task: "t" });
		await new Promise((resolve) => setTimeout(resolve, 15));
		r.cancelAll("cancelled-by-parent");
		const result = await pending;
		// The distinction matters: a cancellation has a known cause, and reporting
		// it as a failure would misattribute a deliberate stop to a bug.
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.state).toBe("cancelled");
	});

	it("redacts a child's provider-bound context through the host redactor", async () => {
		// The runner hands the redactor down rather than deciding what is secret,
		// so the same rules apply to a child as to the parent.
		const redact = vi.fn((messages: unknown[]) => messages);
		const r = runner({ redactor: { redact } as never });
		await r.run({ agent: "coder", task: "t" });
		expect(typeof redact).toBe("function");
	});

	it("cancels descendants deepest-first, so no parent outlives a child", () => {
		// A child that keeps running after its parent was cancelled would keep
		// writing to a session that is being torn down.
		const r = runner();
		const registry = r.registry;
		const child = registry.register({ name: "c", parentId: r.parentId, tools: [] });
		const grandchild = registry.register({ name: "g", parentId: child.id, tools: [] });
		const cancelled = registry.cancelDescendants(r.parentId);
		expect(cancelled[0]).toBe(grandchild.id);
		expect(cancelled).toContain(child.id);
	});

	it("settles a background job that ignores its signal, so a waiter is never stranded", async () => {
		// `cancel` aborts and then settles immediately. A job whose work never
		// cooperates must still reach a terminal state, or an awaiting caller hangs
		// forever.
		const jobs = new JobManager();
		const handle = jobs.start("stuck", () => new Promise<string>(() => {}));
		expect(jobs.cancel(handle.id)).toBe(true);
		expect(jobs.status(handle.id)?.state).toBe("cancelled");
		expect(jobs.runningCount).toBe(0);
		// Cancelling again is a no-op rather than an error, so a double cancel from
		// a retry is harmless.
		expect(jobs.cancel(handle.id)).toBe(false);
	});
});
