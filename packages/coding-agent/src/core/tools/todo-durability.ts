/**
 * Todo durability: which snapshot the session is allowed to believe.
 *
 * ## The failure this prevents
 *
 * A `todo` call changes the plan, and the plan must survive a resume, a rewind,
 * a fork, or `/btw`. If the session reads the todo state from anywhere other
 * than the *committed* record of it, the next rehydration silently reverts the
 * change — and the user has no way to tell, because the tool result is still
 * sitting in the transcript.
 *
 * So the state is read from the branch, from a committed entry, and from
 * nowhere else. A `view` read is not a change and never becomes the snapshot.
 * An errored call did not commit and never becomes the snapshot.
 *
 * ## The fingerprint, and why it is not just a timestamp
 *
 * The snapshot is identified by a fingerprint of its *content*, not by when it
 * was written. Two snapshots with identical content are the same state however
 * far apart they were written, which is what lets a HUD decide whether anything
 * changed without also deciding whether a clock ticked.
 *
 * ## Actionable task
 *
 * The one task the session should be working on: an in-progress item wins over
 * a pending one, whatever order they appear in. A pending item that gets started
 * is then the answer, so a caller can advance the plan by returning it and
 * marking it in progress.
 */

import { createHash } from "node:crypto";

/** The states a task can be in. Mirrors the TUI's `TodoStatus`. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
	/** Why the task is blocked, when it is. */
	readonly blocker?: string;
}

export interface TodoPhase {
	readonly name: string;
	readonly tasks: readonly TodoItem[];
}

/** The entry types that can carry a durable todo snapshot. */
export type TodoSnapshotSource = "user-edit" | "tool-result";

/** What a session needs to know about the current plan. */
export interface TodoSnapshotIdentity {
	/** The branch entry the snapshot came from. */
	readonly sourceEntryId: string;
	/** Content hash of the phases. */
	readonly fingerprint: string;
	/** Whether the snapshot is itself an explicit user edit. */
	readonly source: TodoSnapshotSource;
}

/** The branch entry shapes this module reads. */
export interface TodoSnapshotEntry {
	readonly id: string;
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: {
		readonly role?: string;
		readonly toolName?: string;
		readonly isError?: boolean;
		readonly details?: { op?: unknown; phases?: unknown } | undefined;
	};
}

/** The custom entry type a user edit is recorded under. */
export const USER_TODO_EDIT = "user_todo_edit";

/** Whether a value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { name?: unknown; tasks?: unknown };
	if (typeof record.name !== "string" || !Array.isArray(record.tasks)) return false;
	return record.tasks.every((task) => {
		if (typeof task !== "object" || task === null) return false;
		const item = task as { content?: unknown; status?: unknown; blocker?: unknown };
		if (typeof item.content !== "string") return false;
		if (item.blocker !== undefined && typeof item.blocker !== "string") return false;
		return (
			item.status === "pending" ||
			item.status === "in_progress" ||
			item.status === "completed" ||
			item.status === "abandoned" ||
			item.status === "blocked"
		);
	});
}

/**
 * The phases a successful, state-changing result committed.
 *
 * `undefined` for errors and for a pure `view` read. A `view` does not change
 * the plan, so treating it as a snapshot would make a read freeze the state at
 * whatever it happened to observe.
 */
export function committedTodoPhases(details: unknown, isError: boolean): TodoPhase[] | undefined {
	if (isError) return undefined;
	if (typeof details !== "object" || details === null) return undefined;
	const { op, phases } = details as { op?: unknown; phases?: unknown };
	if (op === "view") return undefined;
	if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases as TodoPhase[];
}

/**
 * A content fingerprint of a phase list.
 *
 * Field order is normalised, and `blocker` is included only when present, so two
 * structurally equal plans hash identically regardless of how they were built.
 */
export function fingerprintTodoPhases(phases: readonly TodoPhase[]): string {
	const canonical = JSON.stringify(
		phases.map((phase) => ({
			name: phase.name,
			tasks: phase.tasks.map((task) =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The phases an entry commits, or `undefined` when it commits nothing. */
function canonicalTodoPhases(entry: TodoSnapshotEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) && phases.every(isTodoPhase) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (!message || message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	return committedTodoPhases(message.details, false);
}

/**
 * The latest durable todo snapshot on the branch.
 *
 * Walks backwards and takes the first entry that commits phases, which is the
 * one nearest the present. Entries that commit nothing - a `view`, an error, a
 * message from another tool - are skipped rather than treated as an empty plan,
 * because "nothing was committed" and "the plan is empty" are different facts
 * and only one of them is true.
 */
export function getLatestTodoSnapshotIdentity(
	entries: readonly TodoSnapshotEntry[],
): TodoSnapshotIdentity | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		const phases = canonicalTodoPhases(entry);
		if (!phases) continue;
		return {
			sourceEntryId: entry.id,
			fingerprint: fingerprintTodoPhases(phases),
			source: entry.type === "custom" && entry.customType === USER_TODO_EDIT ? "user-edit" : "tool-result",
		};
	}
	return undefined;
}

/** The phases of the latest durable snapshot, or `undefined` when there is none. */
export function latestTodoPhases(entries: readonly TodoSnapshotEntry[]): TodoPhase[] | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const phases = canonicalTodoPhases(entries[index]!);
		if (phases) return phases;
	}
	return undefined;
}

/**
 * The task the session should be working on.
 *
 * An in-progress item wins over a pending one whatever the ordering, because
 * resuming work already started is the point of an in-progress marker. Otherwise
 * the first pending item, which is the one to start next.
 */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

/** Whether two snapshots are the same plan. */
export function sameTodoState(left: TodoSnapshotIdentity | undefined, right: TodoSnapshotIdentity | undefined): boolean {
	if (!left || !right) return left === right;
	return left.fingerprint === right.fingerprint;
}
