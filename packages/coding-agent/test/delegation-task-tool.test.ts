import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/core/orchestration/job-manager.ts";
import { TaskRunner, type TaskRunRequest } from "../src/core/orchestration/task-runner.ts";
import { createTaskTool, type TaskOperations } from "../src/core/tools/task.ts";

function model(id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "openrouter",
		id,
		name: id,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...extra,
	} as Model<Api>;
}

const PAID = model("vendor/paid-1");
const FREE = model("vendor/free-1", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

interface Harness {
	ops: TaskOperations;
	runner: TaskRunner;
	jobs: JobManager;
	/** Every call the host received, in order. */
	calls: { request: TaskRunRequest; tools: readonly string[]; model?: Model<Api> }[];
	/** Names the parent holds. */
	parentTools: string[];
	cleanup: () => void;
}

function harness(
	options: {
		parentTools?: string[];
		resolve?: (input: {
			role: string | undefined;
			sessionModel: Model<Api> | undefined;
		}) => Promise<{ model?: Model<Api>; rejectedReason?: string }>;
		/** Fails a gate decision for this tool, to exercise the refusal path. */
		deny?: (toolName: string) => boolean;
	} = {},
): Harness {
	const cwd = mkdtempSync(join(tmpdir(), "pi-delegation-"));
	const parentTools = options.parentTools ?? ["read", "write", "bash"];
	const calls: Harness["calls"] = [];

	const runner = new TaskRunner({
		gate: {
			parentTools,
			beforeToolCall: async (input) =>
				options.deny?.(input.toolName) ? { block: true, reason: "denied by test" } : undefined,
		},
		getSessionModel: () => PAID,
		resolveModel: options.resolve ?? (async () => ({ model: PAID })),
		run: async (input) => {
			calls.push({ request: input.definition, tools: input.tools, model: input.model });
			if (input.signal.aborted) throw new Error("aborted");
			return `done: ${input.definition.task}`;
		},
	});

	const jobs = new JobManager();
	const ops: TaskOperations = {
		runner,
		jobs: {
			list: () => jobs.list(),
			status: (id) => jobs.status(id),
			wait: async (id) => ((await jobs.waitById(id)) === undefined ? undefined : (jobs.status(id)?.result ?? "")),
			cancel: (id) => jobs.cancel(id),
			start: (label, run) => jobs.start(label, run),
		},
		runChild: (request) => runner.run(request),
		parentTools: () => parentTools,
	};

	return {
		ops,
		runner,
		jobs,
		calls,
		parentTools,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

/** Calls the tool the way the agent runtime does. */
async function call(h: Harness, params: Record<string, unknown>) {
	const tool = createTaskTool(h.ops);
	// The wrapper is what the runtime invokes, so the call goes through the same
	// object the agent sees rather than reaching past it.
	return (
		tool.execute as (
			id: string,
			p: unknown,
			signal: AbortSignal,
		) => Promise<{ content: { text: string }[]; details?: unknown }>
	)("call-1", params, new AbortController().signal);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("delegation through the task tool", () => {
	it("runs a child in the foreground and returns its result", async () => {
		const h = harness();
		try {
			const out = await call(h, { op: "run", agent: "coder", task: "fix the parser" });
			expect(out.content[0].text).toBe("done: fix the parser");
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0].request.task).toBe("fix the parser");
		} finally {
			h.cleanup();
		}
	});

	it("narrows a child's tools to a subset of the parent's", async () => {
		const h = harness({ parentTools: ["read", "write"] });
		try {
			// The child asks for `bash`, which the parent does not hold. A child
			// must never be able to widen the tool surface it was handed.
			await call(h, { op: "run", agent: "coder", task: "t", tools: ["read", "bash"] });
			expect([...h.calls[0].tools].sort()).toEqual(["read"]);
		} finally {
			h.cleanup();
		}
	});

	it("resolves a child's model through the parent's own resolution", async () => {
		const h = harness({ resolve: async () => ({ model: FREE }) });
		try {
			await call(h, { op: "run", agent: "coder", task: "t", modelRole: "smol" });
			// The role is a proposal; whatever the host's resolver decides is what
			// the child gets, and the host applies the paid/free authorities.
			expect(h.calls[0].model).toBe(FREE);
			expect(h.calls[0].request.modelRole).toBe("smol");
		} finally {
			h.cleanup();
		}
	});

	it("reports a refusal instead of running when the gate denies a child's tool", async () => {
		const h = harness({ deny: () => true });
		try {
			// The gate is consulted before the child runs, so a denied child leaves
			// no side effect and the model is told why.
			const out = await call(h, { op: "run", agent: "coder", task: "t" });
			expect(out.content[0].text).toMatch(/not started|denied|gate/i);
			expect(h.calls).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	it("returns a job id for a background task and collects it on wait", async () => {
		const h = harness();
		try {
			const started = await call(h, { op: "run", agent: "coder", task: "long job", background: true });
			const jobId = /job `([^`]+)`/.exec(started.content[0].text)?.[1];
			expect(jobId).toBeTruthy();

			// The same tool both starts and collects, so the model needs only one
			// verb set to manage background work.
			const collected = await call(h, { op: "wait", jobId });
			expect(collected.content[0].text).toBe("done: long job");
		} finally {
			h.cleanup();
		}
	});

	it("cancels a running background job", async () => {
		// A job that resolves instantly could never be caught mid-flight, so the
		// assertion is on a job whose work never cooperates.
		const jobs = new JobManager();
		const started = jobs.start("coder", () => new Promise<string>(() => {}));
		expect(jobs.runningCount).toBe(1);
		expect(jobs.cancel(started.id)).toBe(true);
		// Settled even though the work ignored its signal, so a caller awaiting a
		// result is never stranded on a job that will not stop.
		expect(jobs.status(started.id)?.state).toBe("cancelled");
		expect(jobs.runningCount).toBe(0);
	});

	it("reports a background task that never started as a refusal", async () => {
		const h = harness();
		try {
			// Without a `task` there is nothing to delegate, and the model is told
			// so rather than handed a job id that will never resolve.
			const out = await call(h, { op: "run", agent: "coder", background: true });
			expect(out.content[0].text).toMatch(/needs a `task`/i);
			expect(h.jobs.list()).toHaveLength(0);
		} finally {
			h.cleanup();
		}
	});

	it("delivers a policy refusal as the job result rather than throwing", async () => {
		const h = harness({ deny: () => true });
		try {
			const started = await call(h, { op: "run", agent: "coder", task: "t", background: true });
			const jobId = /job `([^`]+)`/.exec(started.content[0].text)?.[1] ?? "";
			const collected = await call(h, { op: "wait", jobId });
			// A refusal is a legitimate outcome to report, not an exception: the
			// model needs to know the task did not run, and why.
			expect(collected.content[0].text).toMatch(/not started/i);
		} finally {
			h.cleanup();
		}
	});

	it("lists jobs and reports status for inspection", async () => {
		const h = harness();
		try {
			await call(h, { op: "run", agent: "coder", task: "t" });
			const jobs = await call(h, { op: "jobs" });
			expect(jobs.content[0].text).toMatch(/no background jobs/i);
			const status = await call(h, { op: "status" });
			expect(status.content[0].text).toMatch(/no job id given/i);
		} finally {
			h.cleanup();
		}
	});

	it("lists agents for inspection", async () => {
		const h = harness();
		try {
			await call(h, { op: "run", agent: "coder", task: "t" });
			const agents = await call(h, { op: "agents" });
			expect(agents.content[0].text).toContain("coder");
		} finally {
			h.cleanup();
		}
	});
});
