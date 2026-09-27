/**
 * TODO items: a structured, event-sourced progress list.
 *
 * ## Traced from OMP
 *
 * `TodoStatus` and `TodoItem` come from `packages/tui/src/tools/todo.ts:20-33`
 * verbatim in shape:
 *
 * ```ts
 * type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
 * interface TodoItem { content: string; status: TodoStatus; blocker?: string; }
 * interface TodoPhase { name: string; tasks: TodoItem[]; }
 * ```
 *
 * Two OMP properties are deliberately **not** carried over:
 *
 * 1. **No `id`, no `dependencies`.** OMP addresses tasks by *verbatim content*
 *    (`findTaskByContent`, `tools/todo.ts:78`) and explicitly errors on
 *    ID-shaped input: "Tasks are referenced by content, not by IDs". The
 *    `TodoTrace` also found the only dependency graph in the codebase is on the
 *    Cursor wire, where it is explicitly refused. So this is a flat ordered list,
 *    and `TodoItem` is content-addressed rather than identified.
 *
 * 2. **No `details` / `notes`.** The `TodoTrace` verified both are declared in
 *    OMP's type but never written or read anywhere — dead optional fields.
 *
 * ## Plans and todos are NOT the same thing
 *
 * The trace is unambiguous: `PlanModeState` has no steps array, `approved-plan.ts`
 * never parses a plan body into items, and the only linkage is model-authored
 * prose ("initialize todo tracking with `todo`"). OMP keeps them distinct, and so
 * does this. Nothing in this file reads or writes `PlanState`.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

/** A single task. Content-addressed: there is no id. */
export interface TodoItem {
	/** Verbatim task text. Doubles as its identity. */
	content: string;
	status: TodoStatus;
	/** Why the task is blocked. Present only when `status === "blocked"`. */
	blocker?: string;
}

/** A named group of tasks, ordered. */
export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** Operations, matching OMP's `TodoOperation`. */
export type TodoOperation = "init" | "start" | "done" | "drop" | "block" | "unblock" | "append" | "view" | "rm";

/** The closed set. Matches OMP's `isClosedTodo`. */
export function isClosedTodo(item: TodoItem): boolean {
	return item.status === "completed" || item.status === "abandoned";
}

/** Default phase name OMP synthesizes for a flat `init`. */
export const DEFAULT_TODO_PHASE = "Tasks";

export interface TodoState {
	phases: TodoPhase[];
}

export const INITIAL_TODO_STATE: TodoState = { phases: [] };

function cloneItem(item: TodoItem): TodoItem {
	// `blocker` is only persisted when set, matching OMP's `cloneTask`, so a
	// serialized snapshot does not accumulate empty-string blockers.
	return item.blocker === undefined
		? { content: item.content, status: item.status }
		: { content: item.content, status: item.status, blocker: item.blocker };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map(cloneItem) }));
}

export function snapshotTodoState(state: TodoState): TodoState {
	return { phases: clonePhases(state.phases) };
}

/**
 * The single-active-task invariant.
 *
 * OMP enforces this in `normalizeInProgressTask` (`tools/todo.ts:126-141`): at
 * most one task is `in_progress` globally, extras demote to `pending`, and if
 * none is active the first `pending` in flattened phase order is promoted.
 * Applied after every mutation so no sequence of operations can produce two
 * active tasks or a list with no active task.
 */
export function normalizeInProgress(phases: TodoPhase[]): TodoPhase[] {
	const normalized = phases.map((phase) => ({ ...phase, tasks: phase.tasks.map(cloneItem) }));

	const activeIndexes: number[] = [];
	for (const phase of normalized) {
		phase.tasks.forEach((task, index) => {
			if (task.status === "in_progress") activeIndexes.push(index);
		});
	}

	if (activeIndexes.length > 1) {
		// Keep the first, demote the rest. Order is the caller's stated intent.
		let seen = 0;
		for (const phase of normalized) {
			for (const task of phase.tasks) {
				if (task.status !== "in_progress") continue;
				seen += 1;
				if (seen > 1) task.status = "pending";
			}
		}
		return normalized;
	}

	if (activeIndexes.length === 0) {
		outer: for (const phase of normalized) {
			for (const task of phase.tasks) {
				if (task.status === "pending") {
					task.status = "in_progress";
					break outer;
				}
			}
		}
	}

	return normalized;
}

/** Finds a task by verbatim content, or undefined. */
export function findTask(phases: TodoPhase[], content: string): { phase: TodoPhase; task: TodoItem } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((candidate) => candidate.content === content);
		if (task) return { phase, task };
	}
	return undefined;
}

/** Total open items across all phases. */
export function openTaskCount(state: TodoState): number {
	return state.phases.reduce((count, phase) => count + phase.tasks.filter((task) => !isClosedTodo(task)).length, 0);
}

/** Counts by status, for rendering. */
export function todoCounts(state: TodoState): Record<TodoStatus, number> {
	const counts: Record<TodoStatus, number> = {
		pending: 0,
		in_progress: 0,
		completed: 0,
		abandoned: 0,
		blocked: 0,
	};
	for (const phase of state.phases) {
		for (const task of phase.tasks) counts[task.status] += 1;
	}
	return counts;
}

/** The single in-progress task, if any. */
export function activeTask(state: TodoState): TodoItem | undefined {
	for (const phase of state.phases) {
		const task = phase.tasks.find((candidate) => candidate.status === "in_progress");
		if (task) return task;
	}
	return undefined;
}

/**
 * Applies one operation.
 *
 * Every branch is total: an operation naming something that does not exist is an
 * error rather than a silent no-op, because a typo that quietly did nothing would
 * leave the model believing the list changed when it did not.
 */
export function applyTodoOperation(
	state: TodoState,
	op: TodoOperation,
	input: {
		task?: string;
		phase?: string;
		items?: string[];
		list?: { phase: string; items: string[] }[];
		reason?: string;
	},
): { state: TodoState; error?: string } {
	// A read never mutates, and never normalizes: viewing a list must not promote
	// a task to in_progress as a side effect.
	if (op === "view") return { state };

	let phases = clonePhases(state.phases);

	switch (op) {
		case "init": {
			const next: TodoPhase[] = input.list
				? input.list.map((phase) => ({
						name: phase.phase,
						tasks: phase.items.map((content) => ({ content, status: "pending" as const })),
					}))
				: [
						{
							name: input.phase || DEFAULT_TODO_PHASE,
							tasks: (input.items ?? []).map((content) => ({ content, status: "pending" as const })),
						},
					];
			if (next.length === 0 || next.every((phase) => phase.tasks.length === 0)) {
				return { state, error: "init requires at least one task." };
			}
			// Duplicate content would be permanently unaddressable, since content is
			// the identity. Same for duplicate phase names.
			const seenPhases = new Set<string>();
			for (const phase of next) {
				if (seenPhases.has(phase.name)) return { state, error: `Duplicate phase name: ${phase.name}.` };
				seenPhases.add(phase.name);
				const seenTasks = new Set<string>();
				for (const task of phase.tasks) {
					if (seenTasks.has(task.content)) {
						return { state, error: `Duplicate task content: ${task.content}. Tasks are addressed by content.` };
					}
					seenTasks.add(task.content);
				}
			}
			return { state: { phases: normalizeInProgress(next) } };
		}

		case "append": {
			const additions = input.items ?? [];
			if (additions.length === 0) return { state, error: "append requires at least one task." };
			// Validate the whole batch before mutating, so a partial append cannot
			// leave the list in a state the model did not ask for.
			const existing = new Set(phases.flatMap((phase) => phase.tasks.map((task) => task.content)));
			for (const content of additions) {
				if (existing.has(content)) return { state, error: `Task already exists: ${content}` };
			}
			const phaseName = input.phase || DEFAULT_TODO_PHASE;
			let phase = phases.find((candidate) => candidate.name === phaseName);
			if (!phase) {
				phase = { name: phaseName, tasks: [] };
				phases.push(phase);
			}
			phase.tasks.push(...additions.map((content) => ({ content, status: "pending" as const })));
			return { state: { phases: normalizeInProgress(phases) } };
		}

		case "start":
		case "done":
		case "drop":
		case "block":
		case "unblock":
		case "rm": {
			const target = input.task;
			if (!target) return { state, error: `${op} requires a task.` };
			const found = findTask(phases, target);
			if (!found) {
				return { state, error: `Task "${target}" not found. Tasks are referenced by content, not by IDs.` };
			}
			// Blocked or closed work is never silently reopened by a status change.
			if (found.task.status === "completed" || found.task.status === "abandoned") {
				if (op !== "rm") {
					return { state, error: `Task "${target}" is ${found.task.status} and cannot be reopened.` };
				}
			}
			if (op === "block" && found.task.status === "completed") {
				return { state, error: `Task "${target}" is completed and cannot be blocked.` };
			}

			if (op === "rm") {
				found.phase.tasks = found.phase.tasks.filter((task) => task.content !== target);
				if (found.phase.tasks.length === 0) phases = phases.filter((phase) => phase.name !== found.phase.name);
				return { state: { phases: normalizeInProgress(phases) } };
			}

			if (op === "start") {
				// Demote whatever was active so exactly one task is in progress.
				for (const phase of phases) {
					for (const task of phase.tasks) {
						if (task.status === "in_progress" && task.content !== target) task.status = "pending";
					}
				}
				found.task.status = "in_progress";
			} else if (op === "done") {
				found.task.status = "completed";
				delete found.task.blocker;
			} else if (op === "drop") {
				found.task.status = "abandoned";
				delete found.task.blocker;
			} else if (op === "block") {
				// The blocker note is normalized to one line, matching OMP.
				found.task.status = "blocked";
				found.task.blocker = (input.reason ?? "blocked").replace(/\s+/g, " ").trim();
			} else if (op === "unblock") {
				found.task.status = "pending";
				delete found.task.blocker;
			}
			return { state: { phases: normalizeInProgress(phases) } };
		}

		default:
			return { state, error: `Unknown todo operation: ${op}` };
	}
}

/**
 * Rebuilds from a persisted snapshot.
 *
 * Normalized on load, because a hand-edited or truncated journal could otherwise
 * restore a list with two active tasks and break the invariant on the next
 * mutation.
 */
export function todoStateFromRecord(record: unknown): TodoState {
	if (!record || typeof record !== "object") return { phases: [] };
	const phases = (record as { phases?: unknown }).phases;
	if (!Array.isArray(phases)) return { phases: [] };

	const restored: TodoPhase[] = [];
	for (const entry of phases) {
		if (!entry || typeof entry !== "object") continue;
		const phase = entry as { name?: unknown; tasks?: unknown };
		if (typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;
		const tasks: TodoItem[] = [];
		for (const rawTask of phase.tasks) {
			if (!rawTask || typeof rawTask !== "object") continue;
			const task = rawTask as { content?: unknown; status?: unknown; blocker?: unknown };
			if (typeof task.content !== "string") continue;
			const statuses: readonly TodoStatus[] = ["pending", "in_progress", "completed", "abandoned", "blocked"];
			const status =
				typeof task.status === "string" && statuses.includes(task.status as TodoStatus)
					? (task.status as TodoStatus)
					: "pending";
			tasks.push(
				task.blocker === undefined
					? { content: task.content, status }
					: {
							content: task.content,
							status,
							blocker: typeof task.blocker === "string" ? task.blocker : "blocked",
						},
			);
		}
		restored.push({ name: phase.name, tasks });
	}
	return { phases: normalizeInProgress(restored) };
}
