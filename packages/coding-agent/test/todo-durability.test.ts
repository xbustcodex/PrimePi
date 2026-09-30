import { describe, expect, it } from "vitest";
import {
	committedTodoPhases,
	fingerprintTodoPhases,
	getLatestTodoSnapshotIdentity,
	isTodoPhase,
	latestTodoPhases,
	nextActionableTask,
	sameTodoState,
	type TodoPhase,
	type TodoSnapshotEntry,
} from "../src/core/tools/todo-durability.ts";

/**
 * Todo durability.
 *
 * The property under test throughout: the plan a session believes must come
 * from a *committed* record. Reading it from anywhere else means a resume,
 * rewind or fork silently reverts a change the user made, with nothing in the
 * transcript to indicate it.
 */

const phase = (name: string, tasks: { content: string; status: string; blocker?: string }[]): TodoPhase =>
	({ name, tasks }) as TodoPhase;

/** A `todo` tool result that committed a change. */
function resultEntry(id: string, phases: TodoPhase[]): TodoSnapshotEntry {
	return { id, type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "start", phases } } };
}

/** A `view` read: observes, does not change. */
function viewEntry(id: string, phases: TodoPhase[]): TodoSnapshotEntry {
	return { id, type: "message", message: { role: "toolResult", toolName: "todo", details: { op: "view", phases } } };
}

/** A failed call: committed nothing. */
function errorEntry(id: string, phases: TodoPhase[]): TodoSnapshotEntry {
	return {
		id,
		type: "message",
		message: { role: "toolResult", toolName: "todo", isError: true, details: { op: "start", phases } },
	};
}

const plan = [
	phase("Build", [
		{ content: "write the module", status: "completed" },
		{ content: "write the test", status: "in_progress" },
	]),
];

describe("a committed snapshot is the one the session believes", () => {
	it("reads the latest committed entry on the branch", () => {
		const entries = [
			resultEntry("e1", [phase("A", [{ content: "old", status: "pending" }])]),
			resultEntry("e2", plan),
		];
		const snapshot = getLatestTodoSnapshotIdentity(entries);
		expect(snapshot?.sourceEntryId).toBe("e2");
		expect(latestTodoPhases(entries)).toEqual(plan);
	});

	it("skips a view read rather than freezing the plan at what it observed", () => {
		// A view does not change the plan. Treating it as a snapshot would make a
		// read the authority on state.
		const entries = [
			resultEntry("e1", plan),
			viewEntry("e2", [phase("A", [{ content: "stale", status: "pending" }])]),
		];
		expect(getLatestTodoSnapshotIdentity(entries)?.sourceEntryId).toBe("e1");
	});

	it("skips a failed call, which committed nothing", () => {
		const entries = [
			resultEntry("e1", plan),
			errorEntry("e2", [phase("A", [{ content: "never", status: "pending" }])]),
		];
		expect(getLatestTodoSnapshotIdentity(entries)?.sourceEntryId).toBe("e1");
	});

	it("reports no snapshot rather than an empty plan", () => {
		// "Nothing was committed" and "the plan is empty" are different facts, and
		// conflating them makes a fresh session look like it forgot its work.
		expect(getLatestTodoSnapshotIdentity([])).toBeUndefined();
		expect(getLatestTodoSnapshotIdentity([viewEntry("e1", plan)])).toBeUndefined();
		expect(getLatestTodoSnapshotIdentity([errorEntry("e1", plan)])).toBeUndefined();
	});

	it("accepts a user edit as the authority", () => {
		// An explicit user edit outranks anything a tool recorded, because the
		// user is the one who knows what the plan is.
		const entries = [
			resultEntry("e1", plan),
			{
				id: "e2",
				type: "custom",
				customType: "user_todo_edit",
				data: { phases: [phase("A", [{ content: "user plan", status: "pending" }])] },
			} satisfies TodoSnapshotEntry,
		];
		const snapshot = getLatestTodoSnapshotIdentity(entries);
		expect(snapshot?.source).toBe("user-edit");
		expect(snapshot?.sourceEntryId).toBe("e2");
	});

	it("survives a rewind, because the snapshot follows the branch", () => {
		// The rewind truncates the branch; what remains is the last committed state
		// before the removed entries, which is the point.
		const full = [
			resultEntry("e1", plan),
			resultEntry("e2", [phase("A", [{ content: "later", status: "pending" }])]),
		];
		const rewound = full.slice(0, 1);
		expect(latestTodoPhases(rewound)).toEqual(plan);
		expect(getLatestTodoSnapshotIdentity(full)?.sourceEntryId).toBe("e2");
		expect(getLatestTodoSnapshotIdentity(rewound)?.sourceEntryId).toBe("e1");
	});
});

describe("validation", () => {
	it("accepts every known status", () => {
		for (const status of ["pending", "in_progress", "completed", "abandoned", "blocked"]) {
			expect(isTodoPhase(phase("A", [{ content: "x", status }]))).toBe(true);
		}
	});

	it("rejects an unknown status rather than dropping the task silently", () => {
		expect(isTodoPhase(phase("A", [{ content: "x", status: "maybe" }]))).toBe(false);
	});

	it("rejects a malformed phase", () => {
		expect(isTodoPhase(null)).toBe(false);
		expect(isTodoPhase({ tasks: [] })).toBe(false);
		expect(isTodoPhase({ name: "A", tasks: "no" })).toBe(false);
	});

	it("rejects a non-string blocker", () => {
		expect(isTodoPhase(phase("A", [{ content: "x", status: "blocked", blocker: 7 as never }]))).toBe(false);
	});
});

describe("committed phases", () => {
	it("returns them for a state-changing success", () => {
		expect(committedTodoPhases({ op: "start", phases: plan }, false)).toEqual(plan);
	});

	it("returns nothing for a view, an error, or a malformed payload", () => {
		expect(committedTodoPhases({ op: "view", phases: plan }, false)).toBeUndefined();
		expect(committedTodoPhases({ op: "start", phases: plan }, true)).toBeUndefined();
		expect(committedTodoPhases({ op: "start", phases: "nope" }, false)).toBeUndefined();
		expect(committedTodoPhases(undefined, false)).toBeUndefined();
	});
});

describe("the fingerprint is content, not time", () => {
	it("is stable for identical content", () => {
		// Two identical plans written far apart are the same state, so a HUD can
		// decide whether anything changed without also watching a clock.
		expect(fingerprintTodoPhases(plan)).toBe(fingerprintTodoPhases(plan));
	});

	it("differs when a task status changes", () => {
		const before = [phase("A", [{ content: "x", status: "pending" }])];
		const after = [phase("A", [{ content: "x", status: "completed" }])];
		expect(fingerprintTodoPhases(before)).not.toBe(fingerprintTodoPhases(after));
	});

	it("differs when a blocker appears", () => {
		const before = [phase("A", [{ content: "x", status: "blocked" }])];
		const after = [phase("A", [{ content: "x", status: "blocked", blocker: "waiting on CI" }])];
		expect(fingerprintTodoPhases(before)).not.toBe(fingerprintTodoPhases(after));
	});

	it("compares two snapshots by fingerprint", () => {
		const a = { sourceEntryId: "e1", fingerprint: "abc", source: "tool-result" as const };
		const b = { sourceEntryId: "e9", fingerprint: "abc", source: "tool-result" as const };
		expect(sameTodoState(a, b)).toBe(true);
		expect(sameTodoState(a, { ...b, fingerprint: "zzz" })).toBe(false);
		expect(sameTodoState(undefined, undefined)).toBe(true);
		expect(sameTodoState(a, undefined)).toBe(false);
	});
});

describe("the actionable task", () => {
	it("prefers an in-progress task over a pending one, whatever the order", () => {
		// Resuming work already started is the point of an in-progress marker.
		const phases = [
			phase("A", [{ content: "pending first", status: "pending" }]),
			phase("B", [{ content: "in progress later", status: "in_progress" }]),
		];
		expect(nextActionableTask(phases)?.content).toBe("in progress later");
	});

	it("falls back to the first pending task", () => {
		const phases = [
			phase("A", [{ content: "done", status: "completed" }]),
			phase("B", [
				{ content: "first pending", status: "pending" },
				{ content: "second pending", status: "pending" },
			]),
		];
		expect(nextActionableTask(phases)?.content).toBe("first pending");
	});

	it("finds nothing when everything is finished or abandoned", () => {
		const phases = [
			phase("A", [
				{ content: "done", status: "completed" },
				{ content: "dropped", status: "abandoned" },
			]),
		];
		expect(nextActionableTask(phases)).toBeUndefined();
		expect(nextActionableTask([])).toBeUndefined();
	});

	it("skips a blocked task, which cannot be worked on", () => {
		const phases = [phase("A", [{ content: "stuck", status: "blocked", blocker: "waiting" }])];
		expect(nextActionableTask(phases)).toBeUndefined();
	});
});
