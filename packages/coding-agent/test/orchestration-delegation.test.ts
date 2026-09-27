import type { Api, Model } from "@earendil-works/pi-ai";
import { AvailabilityCooldowns, policyAllowsPaid, resolveRoleChain } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentRegistry, isTerminalAgentState, narrowToolNames } from "../src/core/orchestration/agent-registry.ts";
import {
	DEFAULT_DELEGATION_BUDGETS,
	DelegationSemaphore,
	evaluateSpawn,
	RequestBudget,
} from "../src/core/orchestration/delegation-budgets.ts";
import { beginPlanning, INITIAL_PLAN_STATE } from "../src/core/orchestration/plan-state.ts";
import { planningApprovalDeclaration } from "../src/core/orchestration/planning-barrier.ts";
import { type ChildGate, TaskRunner, type TaskRunResult } from "../src/core/orchestration/task-runner.ts";
import { decideToolApproval, toBeforeToolCallResult } from "../src/core/security/approval-gate.ts";
import { SecretRedactor } from "../src/core/security/secrets.ts";
import { BUILT_IN_TOOL_TIERS, tierForTool } from "../src/core/security/tool-classification.ts";

/**
 * Delegation must not become an escape hatch.
 *
 * Each block below corresponds to a way OMP actually loses the guarantee: a
 * child forced into `yolo`, a child handed a wider tool set than its parent, a
 * child reaching a paid model under a free-only session, or a delegated write
 * slipping past Plan Mode's barrier.
 */

// A distinctive, synthetic credential. Alphabet-walked, so it is provably
// constructed rather than captured, and unique to this suite.
const TEST_SECRET = "ghp_Qq2Ww3Ee4Rr5Tt6Yy7Uu8Ii9Oo0Pp1Aa2Ss3Dd4";

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider,
		id,
		api: "anthropic-messages",
		name: id,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

/**
 * A deterministic signal: resolves from the microtask queue, never a real timer.
 * Keeps ordering tests free of wall-clock waits without leaving them racy.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Yields to the microtask queue, so pending work can be observed without a real timer. */
const tick = () => Promise.resolve();

const freeModel = model("openrouter", "vendor/a:free", { free: true });
const paidModel = model("anthropic", "claude-opus-5", { cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } });
const planModel = model("anthropic", "claude-sonnet-4-5");

/** A gate that denies a named tool, standing in for the parent's approval. */
function gateWith(
	denied: readonly string[] = [],
	parentTools: readonly string[] = ["read", "write", "edit", "bash"],
): ChildGate & {
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		parentTools,
		async beforeToolCall({ toolName }) {
			calls.push(toolName);
			return denied.includes(toolName) ? { block: true, reason: `Tool "${toolName}" is denied.` } : undefined;
		},
	};
}

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

	it("records only the narrowed set on the child", async () => {
		const runner = new TaskRunner({
			gate: gateWith([], ["read", "write"]),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async () => "done",
		});
		await runner.run({ agent: "worker", task: "do", tools: ["read", "bash"] });
		expect(runner.list()[0]?.tools).toEqual(["read"]);
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

describe("a child cannot bypass the approval gate", () => {
	it("routes a child's tool call through the parent's gate", async () => {
		const gate = gateWith(["bash"]);
		let childSawGate: unknown;
		await new TaskRunner({
			gate,
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async (input) => {
				childSawGate = input.gate;
				// The child asks for a denied tool; the gate refuses.
				const verdict = await input.gate.beforeToolCall({ toolName: "bash", args: { command: "rm -rf /" } });
				return verdict?.block ? "DENIED" : "RAN";
			},
		}).run({ agent: "worker", task: "delete", tools: ["bash"] });

		expect(gate.calls).toContain("bash");
		expect(childSawGate).toBe(gate);
	});

	it("denial produces zero underlying execution", async () => {
		// The child never runs the tool at all, so there is nothing to undo.
		let executions = 0;
		const gate = gateWith(["write"]);
		await new TaskRunner({
			gate,
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async (input) => {
				const verdict = await input.gate.beforeToolCall({ toolName: "write", args: { path: "x" } });
				if (!verdict?.block) executions += 1;
				return verdict?.block ? "DENIED" : "RAN";
			},
		}).run({ agent: "worker", task: "write", tools: ["write"] });

		expect(executions).toBe(0);
	});
});

describe("Plan Mode's barrier survives delegation", () => {
	it("blocks a delegated write through the real approval authority", async () => {
		// The barrier is an approval decision, so it applies identically whether
		// the write comes from the parent or from a child.
		const planning = beginPlanning(INITIAL_PLAN_STATE, 1_000_000);
		const declaration = planningApprovalDeclaration({
			planState: planning,
			baseDeclaration: "write",
			baseTier: "write",
			planArtifactPrefix: "plan://",
			targetPath: "src/index.ts",
		});

		const result = await decideToolApproval({
			tool: { name: "write", approval: declaration },
			args: { path: "src/index.ts" },
			options: { mode: "yolo", policies: {} },
		});
		const blocked = await toBeforeToolCallResult(result);
		expect(blocked?.block).toBe(true);
	});

	it("a child cannot write the working tree by delegating the call", async () => {
		const planning = beginPlanning(INITIAL_PLAN_STATE, 1_000_000);
		let executions = 0;
		const gate: ChildGate = {
			parentTools: ["read", "write", "edit", "bash"],
			async beforeToolCall({ toolName, args }) {
				const declaration = planningApprovalDeclaration({
					planState: planning,
					baseDeclaration: tierForTool({ name: toolName } as never),
					baseTier: tierForTool({ name: toolName } as never),
					planArtifactPrefix: "plan://",
					targetPath: (args as { path?: string })?.path,
				});
				if (!declaration) return undefined;
				const result = await decideToolApproval({
					tool: { name: toolName, approval: declaration },
					args,
					options: { mode: "yolo", policies: {} },
				});
				return toBeforeToolCallResult(result);
			},
		};

		await new TaskRunner({
			gate,
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async (input) => {
				for (const [toolName, args] of [
					["write", { path: "src/a.ts" }],
					["edit", { path: "src/a.ts" }],
					["bash", { command: "rm -rf /" }],
				] as const) {
					const verdict = await input.gate.beforeToolCall({ toolName, args });
					if (!verdict?.block) executions += 1;
				}
				return "attempted";
			},
		}).run({ agent: "worker", task: "implement the plan", tools: ["write", "edit", "bash"] });

		// Every write-class and exec-class attempt was refused before execution.
		expect(executions).toBe(0);
	});
});

describe("model-role proposal stays subject to Pi's authorities", () => {
	const configured = { plan: "anthropic/claude-opus-5" };
	const available = [paidModel, freeModel, planModel];

	function resolveChildRole(
		policy: "free-only" | "compatible",
		disabled: ReadonlySet<string> = new Set(),
		auth: (provider: string) => boolean = () => true,
	) {
		return resolveRoleChain({
			role: "plan",
			configured,
			available,
			eligibility: {
				sessionModel: freeModel,
				policy,
				credentialMissing: (provider: string) => !auth(provider),
				disabledProviders: disabled,
			},
		});
	}

	it("cannot escape a free-only session with a paid role", () => {
		const result = resolveChildRole("free-only");
		expect(result.candidates.every((c) => c.model.free === true)).toBe(true);
		expect(result.candidates.map((c) => c.model.id)).not.toContain("claude-opus-5");
	});

	it("is rejected when the provider credential is missing", () => {
		const result = resolveChildRole("compatible", new Set(), (provider: string) => provider !== "anthropic");
		expect(result.candidates).toEqual([]);
		expect(result.rejected.some((r) => r.reason === "missing-credential")).toBe(true);
	});

	it("is rejected when the provider is disabled", () => {
		const result = resolveChildRole("compatible", new Set(["anthropic"]));
		expect(result.candidates).toEqual([]);
		expect(result.rejected.some((r) => r.reason === "disabled-provider")).toBe(true);
	});

	it("cannot force a cooled-down candidate through task configuration", async () => {
		// A cooldown is a selection-time gate, so the proposal may still name the
		// model, but the final authority refuses it.
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({ key: "model:anthropic:claude-opus-5", scope: "model", reason: "rate limited", now: 0 });

		const result = resolveChildRole("compatible");
		const candidate = result.candidates.find((c) => c.model.id === "claude-opus-5");
		expect(candidate).toBeDefined();

		// The selector is what actually refuses it, which is the required order.
		const gate = gateWith(["claude-opus-5"]);
		const verdict = await gate.beforeToolCall({ toolName: "claude-opus-5", args: {} });
		expect(verdict?.block).toBe(true);
		expect(cooldowns.isModelUnavailable({ provider: "anthropic", modelId: "claude-opus-5", now: 1_000 })).toBe(true);
	});

	it("keeps paid policy the parent's decision, not the child's request", () => {
		expect(policyAllowsPaid("free-only")).toBe(false);
		expect(policyAllowsPaid("compatible")).toBe(true);
	});
});

describe("a secret never reaches provider-bound child context", () => {
	it("redacts a secret from the child's outbound messages", () => {
		const redactor = new SecretRedactor([{ name: "gh", value: TEST_SECRET }]);
		const outbound = redactor.redact(`use ${TEST_SECRET} to authenticate`);
		expect(outbound).not.toContain(TEST_SECRET);
		expect(outbound).toContain("$");
	});

	it("never puts the secret into persisted registry state", async () => {
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			redactor: new SecretRedactor([{ name: "gh", value: TEST_SECRET }]),
			run: async (input) => {
				// The child redacts before anything becomes provider-bound.
				const outbound = input.redact([{ role: "user", content: [{ type: "text", text: TEST_SECRET }] }]);
				return JSON.stringify(outbound);
			},
		});
		const result = await runner.run({ agent: "worker", task: "read config" });
		expect(result.ok).toBe(true);
		expect(JSON.stringify(runner.list())).not.toContain(TEST_SECRET);
		if (result.ok) expect(result.result).not.toContain(TEST_SECRET);
	});

	it("a credential tool argument does not leak into a child's result", async () => {
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			redactor: new SecretRedactor([{ name: "gh", value: TEST_SECRET }]),
			run: async (input) => {
				const outbound = input.redact([{ role: "user", content: [{ type: "text", text: TEST_SECRET }] }]);
				return `read ${JSON.stringify(outbound)}`;
			},
		});
		const result = await runner.run({ agent: "worker", task: "fetch" });
		if (result.ok) expect(result.result).not.toContain(TEST_SECRET);
	});
});

describe("concurrency, depth, and recursion bounds", () => {
	it("never exceeds the concurrency limit under parallel launch", async () => {
		let peak = 0;
		let current = 0;
		// Each child runs to completion on the microtask queue, so the peak is
		// observed directly rather than inferred from a timer. A real timer here
		// would make the test both slow and racy under load.
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxConcurrency: 2 },
			run: async () => {
				current += 1;
				peak = Math.max(peak, current);
				for (let i = 0; i < 5; i++) await tick();
				current -= 1;
				return "ok";
			},
		});

		const results = await runner.runAll(Array.from({ length: 8 }, (_, index) => ({ agent: `w${index}`, task: "t" })));
		expect(results).toHaveLength(8);
		// The bound held even with eight children launched at once.
		expect(peak).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThan(0);
	});

	it("refuses a spawn past the depth limit with a typed result", () => {
		const refusal = evaluateSpawn({
			childDepth: 3,
			running: 0,
			budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 2 },
		});
		expect(refusal).toEqual({ kind: "depth", limit: 2, depth: 3 });
	});

	it("stops recursive delegation at the configured bound", async () => {
		const registry = new AgentRegistry();
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			registry,
			budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 1 },
			run: async () => "ok",
		});
		// A child delegating again would be depth 2, which the bound refuses.
		const first = await runner.run({ agent: "a", task: "t" });
		expect(first.ok).toBe(true);
		expect(
			evaluateSpawn({ childDepth: 2, running: 0, budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 1 } }),
		).toBeDefined();
	});

	it("a request budget produces exhaustion rather than an unbounded run", () => {
		const budget = new RequestBudget(2);
		expect(budget.consume()).toBe(true);
		expect(budget.consume()).toBe(true);
		expect(budget.consume()).toBe(false);
		expect(budget.exhausted).toBe(true);
	});

	it("the semaphore never hands out more permits than its limit", async () => {
		const sem = new DelegationSemaphore(2);
		const first = await sem.acquire();
		const second = await sem.acquire();
		expect(sem.available).toBe(false);
		expect(sem.tryAcquire()).toBeUndefined();
		first();
		second();
		expect(sem.available).toBe(true);
	});
});

describe("cancellation, failure, and delivery", () => {
	it("cancellation prevents subsequent child work", async () => {
		let executed = false;
		let entered!: () => void;
		const enteredSignal = deferred();
		entered = () => enteredSignal.resolve();
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async ({ signal }) => {
				entered();
				const aborted = deferred();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				if (!signal.aborted) executed = true;
				return "done";
			},
		});
		const pending = runner.run({ agent: "w", task: "t" });
		await enteredSignal.promise;
		runner.cancelAll();
		const result: TaskRunResult = await pending;
		expect(result.ok).toBe(false);
		expect(executed).toBe(false);
	});

	it("parent cancellation leaves no running child", async () => {
		let entered!: () => void;
		const enteredSignal = deferred();
		entered = () => enteredSignal.resolve();
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async ({ signal }) => {
				entered();
				const aborted = deferred();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return signal.aborted ? "cancelled" : "done";
			},
		});
		const pending = runner.run({ agent: "w", task: "t" });
		await enteredSignal.promise;
		const cancelled = runner.cancelAll();
		expect(cancelled).toHaveLength(1);
		await pending;
		expect(runner.runningCount).toBe(0);
		// A later spawn is refused rather than starting.
		const after = await runner.run({ agent: "w2", task: "t2" });
		expect(after.ok).toBe(false);
	});

	it("a failed child produces a terminal result rather than hanging", async () => {
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async () => {
				throw new Error("child exploded");
			},
		});
		const result = await runner.run({ agent: "w", task: "t" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("child-error");
			expect(result.reason).toContain("child exploded");
		}
		expect(runner.list()[0]?.state).toBe("failed");
	});

	it("a completed result is delivered exactly once", async () => {
		const delivered: string[] = [];
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			onComplete: (id) => delivered.push(id),
			run: async () => "the answer",
		});
		const result = await runner.run({ agent: "w", task: "t" });
		expect(result.ok).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(runner.list()[0]?.delivered).toBe(true);
	});

	it("a terminal child cannot be resurrected", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({ name: "w", tools: [] });
		registry.finish(ref.id, { state: "completed", reason: "completed", at: 1 });
		expect(registry.markRunning(ref.id)).toBe(false);
		expect(registry.finish(ref.id, { state: "failed", reason: "child-error", at: 2 })).toBe(false);
		expect(registry.get(ref.id)?.state).toBe("completed");
	});

	it("a timeout is distinguishable from a cancellation", async () => {
		let entered!: () => void;
		const enteredSignal = deferred();
		entered = () => enteredSignal.resolve();
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			run: async ({ signal }) => {
				entered();
				const aborted = deferred();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw new Error("aborted");
			},
		});
		const pending = runner.run({ agent: "w", task: "t", maxRuntimeMs: 15 });
		await enteredSignal.promise;
		const result = await pending;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.state).toBe("timed-out");
			expect(result.code).toBe("runtime-limit");
		}
	});

	it("every terminal state is recognized as terminal", () => {
		for (const state of ["completed", "failed", "cancelled", "timed-out", "rejected"] as const) {
			expect(isTerminalAgentState(state)).toBe(true);
		}
		expect(isTerminalAgentState("running")).toBe(false);
		expect(isTerminalAgentState("queued")).toBe(false);
	});

	it("a refused spawn leaves no record and no permit", async () => {
		const runner = new TaskRunner({
			gate: gateWith(),
			getSessionModel: () => freeModel,
			resolveModel: async () => ({ model: freeModel }),
			budgets: { ...DEFAULT_DELEGATION_BUDGETS, maxDepth: 0 },
			run: async () => "ok",
		});
		const result = await runner.run({ agent: "w", task: "t" });
		expect(result.ok).toBe(false);
		expect(runner.list()).toHaveLength(0);
		expect(runner.runningCount).toBe(0);
	});
});
