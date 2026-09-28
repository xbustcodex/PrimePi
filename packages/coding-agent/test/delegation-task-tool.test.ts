import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	const ops: TaskOperations = {
		runner,
		runChild: (request) => runner.run(request),
		parentTools: () => parentTools,
	};

	return {
		ops,
		runner,
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
