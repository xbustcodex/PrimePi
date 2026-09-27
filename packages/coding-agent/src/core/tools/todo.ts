/**
 * The `todo` tool: structured progress tracking within a session.
 *
 * ## Traced from OMP, with one deliberate divergence
 *
 * OMP's `TodoTool` (`tools/todo.ts:712-770`) declares
 * `readonly approval = "read"`. The `TodoTrace` confirmed that means a todo
 * mutation passes through **no** approval gate in any mode, because
 * `modeApprovesTier("always-ask", "read")` is true.
 *
 * This port declares `write`. The requirement for this phase is explicit: TODO
 * mutations are write-class operations and must participate in the Phase 3
 * approval architecture. `write` is the right class rather than `exec`: the
 * operation mutates session-scoped structured state, not the user's filesystem,
 * and it is routinely called many times per turn, so an `exec` tier would make
 * ordinary progress tracking unusable under a strict mode.
 *
 * Everything else follows OMP: the same status enum including `abandoned`,
 * content-addressed tasks with no id, the same nine operations, and the
 * single-active-task invariant.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	activeTask,
	applyTodoOperation,
	isClosedTodo,
	openTaskCount,
	type TodoOperation,
	type TodoPhase,
	type TodoState,
	todoCounts,
} from "../orchestration/todo-state.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** Where the tool reads and writes its list. Supplied by the session. */
export interface TodoOperations {
	get(): TodoState;
	set(state: TodoState): void;
}

const todoSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("init"),
			Type.Literal("start"),
			Type.Literal("done"),
			Type.Literal("drop"),
			Type.Literal("block"),
			Type.Literal("unblock"),
			Type.Literal("append"),
			Type.Literal("view"),
			Type.Literal("rm"),
		],
		{ description: "The operation to perform." },
	),
	task: Type.Optional(
		Type.String({ description: "Verbatim task content. Tasks are addressed by content, never by generated ids." }),
	),
	phase: Type.Optional(Type.String({ description: "Phase name, for init/append or a phase-wide target." })),
	items: Type.Optional(Type.Array(Type.String(), { description: "Task contents for a flat init or an append." })),
	list: Type.Optional(
		Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String()) }), {
			description: "Phases for init.",
		}),
	),
	reason: Type.Optional(Type.String({ description: "Blocker note, for block." })),
});

export type TodoParams = Static<typeof todoSchema>;

/** The `details` payload, mirroring OMP's `TodoToolDetails`. */
export interface TodoToolDetails {
	op: TodoOperation;
	phases: TodoPhase[];
	completedTasks: { phase: string; content: string }[];
}

export const todoToolSystemPromptContribution = {
	snippet: "Track structured progress within a session with a todo list",
	guidelines: [
		"Tasks are identified by verbatim content, never by generated ids.",
		"Exactly one task is in progress at a time; starting another demotes the first.",
		"A blocked task needs a reason and stays blocked until unblocked.",
	],
} as const;

/** Human-facing summary, mirroring OMP's `formatSummary`. */
export function formatTodoSummary(state: TodoState, op: TodoOperation): string {
	if (op === "view" && state.phases.length === 0) return "No todos.";
	const counts = todoCounts(state);
	const total = counts.pending + counts.in_progress + counts.completed + counts.abandoned + counts.blocked;
	const open = openTaskCount(state);
	const active = activeTask(state);

	const lines: string[] = [];
	for (const phase of state.phases) {
		if (phase.tasks.length === 0) continue;
		lines.push(`${phase.name}`);
		for (const task of phase.tasks) {
			const marker =
				task.status === "completed"
					? "x"
					: task.status === "in_progress"
						? ">"
						: task.status === "blocked"
							? "!"
							: task.status === "abandoned"
								? "-"
								: " ";
			const blocker = task.blocker ? ` (blocked: ${task.blocker})` : "";
			lines.push(`  [${marker}] ${task.content}${blocker}`);
		}
	}

	const overall =
		`Overall: ${counts.completed}/${total} done` +
		(open > 0 ? `, ${open} open` : "") +
		(counts.blocked > 0 ? `, ${counts.blocked} blocked` : "") +
		(counts.abandoned > 0 ? `, ${counts.abandoned} abandoned` : "");

	return [...lines, overall, active ? `Active: ${active.content}` : ""].filter(Boolean).join("\n");
}

export function createTodoToolDefinition(
	operations: TodoOperations,
): ToolDefinition<typeof todoSchema, TodoToolDetails | undefined> {
	return {
		name: "todo",
		label: "Todo",
		description:
			"Track structured progress within a session. Tasks live in named phases and are addressed by verbatim content. Use init to replace the list, append to add, start/done/drop/block/unblock to change a task's state, rm to remove, and view to read.",
		promptSnippet: todoToolSystemPromptContribution.snippet,
		promptGuidelines: [...todoToolSystemPromptContribution.guidelines],
		parameters: todoSchema,
		// Tier is declared in `security/tool-classification.ts` rather than here:
		// `ToolDefinition` has no approval field, and the classification table is
		// the one place Pi's approval authority reads a tool's risk from.
		async execute(
			_toolCallId: string,
			params: TodoParams,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: ExtensionContext,
		): Promise<AgentToolResult<TodoToolDetails | undefined>> {
			const current = operations.get();
			const { state, error } = applyTodoOperation(current, params.op as TodoOperation, {
				task: params.task,
				phase: params.phase,
				items: params.items,
				list: params.list,
				reason: params.reason,
			});

			// A batch with any error is discarded wholesale. A partial application
			// would leave the list in a state the model did not ask for, and the
			// model would believe a change it did not get.
			// Errors are thrown rather than returned: Pi's tool contract encodes
			// failure as a throw, and a returned object would reach the model as a
			// success it did not get.
			if (error) throw new Error(`Todo error: ${error}`);

			if (params.op !== "view") operations.set(state);

			const completedTasks = diffCompleted(current, state);
			const text = formatTodoSummary(state, params.op as TodoOperation);
			return {
				content: [{ type: "text", text }],
				details: { op: params.op as TodoOperation, phases: state.phases, completedTasks },
			};
		},
	};
}

/**
 * Tasks that moved to a closed status as a result of this operation.
 *
 * Reported so the model and the UI can react to completion without diffing the
 * whole list themselves.
 */
function diffCompleted(before: TodoState, after: TodoState): { phase: string; content: string }[] {
	const beforeClosed = new Set(
		before.phases.flatMap((phase) => phase.tasks.filter(isClosedTodo).map((task) => task.content)),
	);
	const completed: { phase: string; content: string }[] = [];
	for (const phase of after.phases) {
		for (const task of phase.tasks) {
			if (isClosedTodo(task) && !beforeClosed.has(task.content)) {
				completed.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return completed;
}

export function createTodoTool(operations: TodoOperations): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoToolDefinition(operations));
}
