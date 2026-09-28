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
import type { TaskRunner, TaskRunRequest, TaskRunResult } from "../orchestration/task-runner.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

/** What the tool needs from its session. Injected, so no global state. */
export interface TaskOperations {
	/** The delegation engine. */
	runner: TaskRunner;
	/** Runs one child to completion. */
	runChild(request: TaskRunRequest): Promise<TaskRunResult>;
	/** Tool names the parent currently has, the ceiling for any child. */
	parentTools(): readonly string[];
}

const taskSchema = Type.Object({
	op: Type.Union([Type.Literal("run"), Type.Literal("agents")], {
		description: "run: delegate work. agents: inspect the children this session has run.",
	}),
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
});

export type TaskParams = Static<typeof taskSchema>;

/** The `details` payload, so a UI can render without parsing text. */
export interface TaskToolDetails {
	/** Results for a foreground `run`, absent for a background spawn. */
	results?: TaskRunResult[];
	/** A summary of the registry, for `agents` and `status`. */
	agents?: { id: string; name: string; state: string; depth: number }[];
	/** A worktree the child was given, so the operator can inspect or merge it. */
	worktree?: { taskId: string; path: string; baseSha: string };
	/** True when the call did not execute because of a policy refusal. */
	refused?: true;
}

function describeAgents(refs: AgentRef[]): TaskToolDetails["agents"] {
	return refs.map((ref) => ({ id: ref.id, name: ref.name, state: ref.state, depth: ref.depth }));
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
			"A child can only use tools you already have, and every tool it calls is approved by your own policy.",
		promptSnippet: "Delegate work to a child agent",
		promptGuidelines: [
			"Children start blank; pass the context they need in `context`, never the transcript.",
			"A child's tools are narrowed to a subset of yours, and its model choice still goes through your own policy.",
		],
		parameters: taskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.op) {
				case "run": {
					const result = await ops.runChild(buildRequest(params));
					if (!result.ok) {
						// A refusal is reported rather than thrown, so the model can
						// adapt — a different role, fewer tools — instead of the whole
						// delegation collapsing.
						return {
							content: [{ type: "text", text: refusalText(result) }],
							details: { refused: true, results: [result] } satisfies TaskToolDetails,
						};
					}
					return {
						content: [{ type: "text", text: result.result }],
						details: { results: [result] } satisfies TaskToolDetails,
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
				default:
					throw new Error(`Unknown task operation: ${params.op}`);
			}
		},
	};
}

function buildRequest(params: TaskParams): TaskRunRequest {
	return {
		agent: params.agent ?? "task",
		task: params.task ?? "",
		...(params.context ? { context: params.context } : {}),
		...(params.tools ? { tools: params.tools } : {}),
		...(params.modelRole ? { modelRole: params.modelRole } : {}),
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
