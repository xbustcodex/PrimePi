/**
 * The `task` tool: delegation from an ordinary interactive session.
 *
 * ## What the source trace changed about the design
 *
 * OMP has no `background` argument. The trace found the decision is made in two
 * steps the model never sees: agent frontmatter `blocking: true` forces inline,
 * and otherwise the `async.enabled` setting plus a registered job manager decide.
 * The model learns the job id only from the returned text, and a *second* tool
 * (`wait`) is needed to collect the result.
 *
 * This contract is explicit instead. `background: true` is a parameter the model
 * sets, so the choice is visible in the transcript rather than inferred, and the
 * same tool both starts and collects — which keeps the public surface to one
 * verb set instead of two.
 *
 * ## The guarantee that matters
 *
 * **Delegation is an orchestration tool, not a privileged one.** It is classified
 * `exec` in the Phase 3 table like any other tool that can change the world, so it
 * is gated by the same authority, is refused by the same Plan Mode barrier, and
 * cannot be used to reach a model the parent's own policy would not allow.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { AgentRef } from "../orchestration/agent-registry.js";
import type { JobHandle, JobRecord } from "../orchestration/job-manager.js";
import type { TaskRunner, TaskRunRequest, TaskRunResult } from "../orchestration/task-runner.js";
import type { WorktreeManager } from "../orchestration/worktree-manager.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

/** What the tool needs from its session. Injected, so no global state. */
export interface TaskOperations {
	/** The delegation engine. */
	runner: TaskRunner;
	/** Background job substrate. */
	jobs: {
		list(): JobRecord[];
		status(id: string): JobRecord | undefined;
		/**
		 * Awaits a job by id and resolves its result text, or undefined when the id
		 * is unknown. Resolving rather than rejecting keeps a poll after a restart
		 * from throwing.
		 */
		wait(id: string): Promise<string | undefined>;
		cancel(id: string): boolean;
		/** Starts background work and returns a handle. */
		start(label: string, run: (input: { signal: AbortSignal; jobId: string }) => Promise<string>): JobHandle;
	};
	/** Workspace provisioning. */
	worktrees?: WorktreeManager;
	runChild(request: TaskRunRequest): Promise<TaskRunResult>;
	/** Tool names the parent currently has, the ceiling for any child. */
	parentTools(): readonly string[];
}

const taskSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("run"),
			Type.Literal("status"),
			Type.Literal("wait"),
			Type.Literal("result"),
			Type.Literal("cancel"),
			Type.Literal("agents"),
			Type.Literal("jobs"),
		],
		{
			description:
				"run: delegate work. status/wait/result/cancel: manage a background job. agents/jobs: inspect state.",
		},
	),
	agent: Type.Optional(Type.String({ description: "Agent name for the child, for diagnostics and policy." })),
	task: Type.Optional(Type.String({ description: "The assignment handed to the child." })),
	context: Type.Optional(
		Type.String({
			description:
				"Extra context the child needs. The child never sees the parent's transcript, so anything it must know goes here.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tools this child requests. Narrowed against yours; it can only ever be a subset.",
		}),
	),
	modelRole: Type.Optional(
		Type.String({
			description:
				"Preferred model role for the child, e.g. 'smol'. A preference only: it is resolved through your own access, credential and spending rules.",
		}),
	),
	isolated: Type.Optional(
		Type.Boolean({ description: "Give the child its own git worktree so its changes cannot land in your checkout." }),
	),
	background: Type.Optional(
		Type.Boolean({ description: "Return immediately with a job id instead of waiting for the child." }),
	),
	jobId: Type.Optional(Type.String({ description: "Which job, for status/wait/result/cancel." })),
});

export type TaskParams = Static<typeof taskSchema>;

/** The `details` payload, so a UI can render without parsing text. */
export interface TaskToolDetails {
	/** Results for a foreground `run`, absent for a background spawn. */
	results?: TaskRunResult[];
	/** Present when the call started background work. */
	job?: { id: string; state: string; label: string };
	/** A summary of the registry, for `agents` and `status`. */
	agents?: { id: string; name: string; state: string; depth: number }[];
	/** A summary of the jobs, for `jobs` and `status`. */
	jobs?: { id: string; label: string; state: string }[];
	/** A worktree the child was given, so the operator can inspect or merge it. */
	worktree?: { taskId: string; path: string; baseSha: string };
	/** True when the call did not execute because of a policy refusal. */
	refused?: true;
}

function describeAgents(refs: AgentRef[]): TaskToolDetails["agents"] {
	return refs.map((ref) => ({ id: ref.id, name: ref.name, state: ref.state, depth: ref.depth }));
}

function describeJobs(jobs: JobRecord[]): TaskToolDetails["jobs"] {
	return jobs.map((job) => ({ id: job.id, label: job.label, state: job.state }));
}

/** Renders a refusal so the model learns what to change rather than just that it failed. */
function refusalText(result: Extract<TaskRunResult, { ok: false }>): string {
	return `Task not started (${result.code}). ${result.reason}`;
}

export function createTaskToolDefinition(ops: TaskOperations): ToolDefinition<typeof taskSchema, TaskToolDetails> {
	return {
		name: "task",
		label: "Task",
		description:
			"Delegate work to a child agent. The child starts with no history, so put anything it must know in `context`. " +
			"Set `isolated: true` to give a coding child its own git worktree — its changes are reported, never merged into your checkout. " +
			"Set `background: true` to get a job id back immediately, then use `status`, `wait`, `result`, or `cancel` with it. " +
			"A child can only use tools you already have, and every tool it calls is approved by your own policy.",
		promptSnippet: "Delegate work to a child agent",
		promptGuidelines: [
			"Children start blank; pass the context they need in `context`, never the transcript.",
			"Use `isolated: true` for any child that edits files, so its changes cannot land in your checkout.",
			"A child's tools are narrowed to a subset of yours, and its model choice still goes through your own policy.",
			"Use `background: true` for work you do not need to wait on, and collect it later with `wait`.",
		],
		parameters: taskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.op) {
				case "run":
					return params.background ? runBackground(ops, params) : runForeground(ops, params);
				case "status": {
					if (!params.jobId) {
						const agents = describeAgents(ops.runner.list()) ?? [];
						return {
							content: [{ type: "text", text: `No job id given. ${agents.length} child(ren) known.` }],
							details: { agents },
						};
					}
					const job = ops.jobs.status(params.jobId);
					return {
						content: [
							{
								type: "text",
								text: job ? `Job ${job.id} (${job.label}) is ${job.state}.` : `No job ${params.jobId}.`,
							},
						],
						details: { jobs: describeJobs(ops.jobs.list()) ?? [] },
					};
				}
				case "wait":
				case "result": {
					if (!params.jobId) {
						throw new Error("wait requires a jobId. Run the task with background: true to get one.");
					}
					const settled = await ops.jobs.wait(params.jobId);
					if (settled === undefined) {
						throw new Error(`No job ${params.jobId}.`);
					}
					const job = ops.jobs.status(params.jobId);
					const result = settled.length > 0 ? settled : (job?.result ?? "");
					return {
						content: [
							{
								type: "text",
								text:
									result.length > 0 ? result : `Job ${params.jobId} finished as ${job?.state ?? "unknown"}.`,
							},
						],
						details: { jobs: describeJobs(ops.jobs.list()) ?? [] },
					};
				}
				case "cancel": {
					if (!params.jobId) throw new Error("cancel requires a jobId.");
					const cancelled = ops.jobs.cancel(params.jobId);
					return {
						content: [
							{
								type: "text",
								text: cancelled ? `Job ${params.jobId} cancelled.` : `Job ${params.jobId} was not running.`,
							},
						],
						details: { jobs: describeJobs(ops.jobs.list()) ?? [] },
					};
				}
				case "agents": {
					const agents = describeAgents(ops.runner.list()) ?? [];
					const text =
						agents.length === 0
							? "No child agents have run in this session."
							: agents
									.map((agent) => `${agent.id} (${agent.name}) ${agent.state} depth=${agent.depth}`)
									.join("\n");
					return { content: [{ type: "text", text }], details: { agents } };
				}
				case "jobs": {
					const jobs = describeJobs(ops.jobs.list()) ?? [];
					const text =
						jobs.length === 0
							? "No background jobs."
							: jobs.map((job) => `${job.id} (${job.label}) ${job.state}`).join("\n");
					return { content: [{ type: "text", text }], details: { jobs } };
				}
				default:
					throw new Error(`Unknown task operation: ${params.op}`);
			}
		},
	};
}

async function runForeground(
	ops: TaskOperations,
	params: TaskParams,
): Promise<{ content: { type: "text"; text: string }[]; details: TaskToolDetails }> {
	const result = await ops.runChild(buildRequest(params));
	if (!result.ok) {
		// A refusal is reported rather than thrown, so the model can adapt — a
		// different role, fewer tools — instead of the delegation collapsing.
		return {
			content: [{ type: "text", text: refusalText(result) }],
			details: { refused: true, results: [result] },
		};
	}
	return { content: [{ type: "text", text: result.result }], details: { results: [result] } };
}

async function runBackground(
	ops: TaskOperations,
	params: TaskParams,
): Promise<{ content: { type: "text"; text: string }[]; details: TaskToolDetails }> {
	if (!params.task) {
		return {
			content: [{ type: "text", text: "A background task needs a `task` describing the work." }],
			details: { refused: true },
		};
	}

	const label = params.agent ?? "task";
	const handle = ops.jobs.start(label, async ({ signal }) => {
		const result = await ops.runChild({ ...buildRequest(params), background: true });
		if (signal.aborted) {
			// The job record already records the cancellation; returning early avoids
			// reporting a result the parent will never receive.
			return "";
		}
		if (!result.ok) {
			// A refusal is a legitimate outcome to report, not an exception: the
			// model needs to know the task did not run and why.
			return refusalText(result);
		}
		return result.result;
	});

	return {
		content: [
			{
				type: "text",
				text:
					`Started background task \`${label}\` (job \`${handle.id}\`). ` +
					"Use `wait` or `result` with that job id to collect the outcome, or `cancel` to stop it.",
			},
		],
		details: { job: { id: handle.id, state: "running", label } },
	};
}

function buildRequest(params: TaskParams): TaskRunRequest {
	return {
		agent: params.agent ?? "task",
		task: params.task ?? "",
		...(params.context ? { context: params.context } : {}),
		...(params.tools ? { tools: params.tools } : {}),
		...(params.modelRole ? { modelRole: params.modelRole } : {}),
		...(params.isolated ? { isolation: "worktree" as const } : {}),
		...(params.background ? { background: true } : {}),
	};
}

/**
 * Wraps the definition for the agent runtime.
 *
 * The tool closes over its operations exactly as `todo` does, so it needs no
 * access to the session beyond what was injected at construction.
 */
export function createTaskTool(ops: TaskOperations) {
	return wrapToolDefinition(createTaskToolDefinition(ops));
}
