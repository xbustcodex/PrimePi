import { afterEach, describe, expect, it } from "vitest";
import { DELEGATION_RECOVERY_ENTRY_TYPE } from "../src/core/orchestration/delegation-journal.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import type { TaskOperations } from "../src/core/tools/task.ts";
import { createTaskTool } from "../src/core/tools/task.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Delegated-child recovery, end to end through a real `AgentSession`.
 *
 * The other recovery suite proves the journal and the tool. This one proves the
 * wiring that only the session can do: that a job started through a real session
 * is journaled, and that a *second* `AgentSession` over the same session — same
 * entries, new process, which is what a restart is — recovers it and tells the
 * parent without the parent asking.
 *
 * Without that second half the whole thing is a query API: correct answers that
 * reach nobody unless they go looking.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const h = await createHarness(options);
	cleanups.push(() => h.cleanup());
	return h;
}

/** Calls the real `task` tool the way the agent runtime does. */
async function task(
	h: Harness,
	params: Record<string, unknown>,
): Promise<{ content: { text: string }[]; details?: { job?: { id: string } } }> {
	const tool = createTaskTool(taskOperations(h));
	return (
		tool.execute as unknown as (
			id: string,
			p: unknown,
			signal: AbortSignal,
		) => Promise<{ content: { text: string }[]; details?: { job?: { id: string } } }>
	)("call-1", params, new AbortController().signal);
}

/**
 * The tool's dependencies, read off the session exactly as the session's own
 * `_taskOperations` does — through the public `taskRunner` and `taskJobs`, not
 * through anything private.
 */
function taskOperations(h: Harness): TaskOperations {
	const runner = h.session.taskRunner;
	const journal = h.session.delegationJournal;
	return {
		runner,
		jobs: {
			list: () => h.session.taskJobs.list(),
			status: (id) => h.session.taskJobs.status(id),
			wait: async (id) =>
				(await h.session.taskJobs.waitById(id)) === undefined
					? undefined
					: (h.session.taskJobs.status(id)?.result ?? ""),
			cancel: (id) => h.session.taskJobs.cancel(id),
			start: (label, run) => h.session.taskJobs.start(label, run),
			markDelivered: (id) => h.session.taskJobs.markDelivered(id),
			recovered: () => journal.recovered,
			markRecoveredDelivered: (id) => journal.markDelivered(id),
			writeError: () => journal.writeFailure,
		},
		runChild: (request) => runner.run(request),
		parentTools: () => h.session.getActiveToolNames(),
	};
}

/** The text of the recovery notice on the branch, if one was written. */
function recoveryNotices(h: Harness): string[] {
	return (
		h.sessionManager
			.getBranch()
			// A predicate, not a boolean: `filter` only narrows the union when the
			// callback says so, and `content` exists on a custom message and nowhere else.
			.filter(
				(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
					entry.type === "custom_message" && entry.customType === DELEGATION_RECOVERY_ENTRY_TYPE,
			)
			.map((entry) => (typeof entry.content === "string" ? entry.content : ""))
	);
}

describe("delegation recovery across a session restart", () => {
	it("tells the parent about a child that was interrupted, without the parent asking", async () => {
		const first = await harness();
		// Work that never settles: the process ends with the child mid-flight.
		const never = new Promise<string>(() => {});
		first.session.taskJobs.start("coder", () => never);
		// The journal must already hold the running record, or a crash here leaves
		// nothing for a restart to recover.
		expect(first.session.delegationJournal.recoveredIds).toEqual([]);
		expect(first.sessionManager.getBranch().some((entry) => entry.type === "custom")).toBe(true);

		// A restart: same session entries, a brand new session and job substrate.
		const second = await harness({ sessionManager: first.sessionManager });
		const notices = recoveryNotices(second);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("still running when the session ended");
		// The parent must be told the child was stopped, not merely that something
		// is missing, or it will re-issue the delegation and pay for the work twice.
		expect(notices[0]).toContain("interrupted and not resumed");
		expect(notices[0]).toContain("do not assume any of it finished");
		// And the recovered child is reachable through the tool, with a result
		// call that reports rather than claims a job does not exist.
		const status = await task(second, { op: "status", jobId: "job-1" });
		expect(status.content[0].text).toContain("is interrupted");
		const result = await task(second, { op: "result", jobId: "job-1" });
		expect(result.content[0].text).toContain("was still running when the session ended");
	});

	it("does not repeat the notice on a further resume of the same state", async () => {
		const first = await harness();
		first.session.taskJobs.start("coder", () => new Promise<string>(() => {}));
		const second = await harness({ sessionManager: first.sessionManager });
		expect(recoveryNotices(second)).toHaveLength(1);

		// A third process over the same, unchanged state must stay quiet. The notice
		// is stamped with the journal entry it reports on, and that entry has not
		// changed, so there is nothing new to say.
		const third = await harness({ sessionManager: first.sessionManager });
		expect(recoveryNotices(third)).toHaveLength(1);
	});

	it("does not claim a journal written by a different session", async () => {
		const first = await harness();
		first.session.taskJobs.start("coder", () => new Promise<string>(() => {}));

		// A different session, reading the same branch. Ownership is checked before
		// anything is adopted, so one session's recovery cannot report another's work.
		const other = SessionManager.inMemory();
		other.appendCustomEntry("pi.delegation-journal", {
			version: 1,
			sessionId: "a-session-that-is-not-this-one",
			jobs: [{ id: "job-9", label: "someone else's child", state: "interrupted", startedAt: 1, delivered: false }],
		});
		const mine = await harness({ sessionManager: other });
		expect(mine.session.delegationJournal.recovered.jobs).toEqual([]);
		expect(recoveryNotices(mine)).toEqual([]);
		expect((await task(mine, { op: "status", jobId: "job-9" })).content[0].text).toBe("No job job-9.");
	});

	it("survives a clean shutdown without reporting a crash", async () => {
		const first = await harness();
		first.session.taskJobs.start("coder", () => new Promise<string>(() => {}));
		// What `AgentSession.dispose` does on the way out.
		expect(first.session.taskJobs.cancelAll("Session was disposed.")).toEqual(["job-1"]);

		const second = await harness({ sessionManager: first.sessionManager });
		expect(second.session.delegationJournal.recovered.jobs[0]?.state).toBe("cancelled");
		// The parent does still learn the job was cancelled and its result never
		// arrived. What it must not be told is that the work was interrupted, or
		// that it has to be started again — that is a different fact, and conflating
		// them would make every ordinary session exit read as a crash.
		const notices = recoveryNotices(second).join("\n");
		expect(notices).toContain("cancelled");
		expect(notices).not.toMatch(/interrupted|not resumed|not completed/i);
		expect(second.session.delegationJournal.recovered.interruptedAgents).toEqual([]);
	});

	it("journals a settled result so the next session can still deliver it", async () => {
		const first = await harness();
		const handle = first.session.taskJobs.start("coder", async () => "the answer");
		await handle.wait();
		expect(first.session.taskJobs.status(handle.id)?.result).toBe("the answer");

		const second = await harness({ sessionManager: first.sessionManager });
		const collected = await task(second, { op: "result", jobId: "job-1" });
		expect(collected.content[0].text).toBe("the answer");
		// The notice written before collection stays on the branch — it is history,
		// and history is not rewritten. What collection must prevent is a *new* one:
		// a further resume reads the delivered flag and has nothing left to report.
		expect(recoveryNotices(second)).toHaveLength(1);
		const third = await harness({ sessionManager: first.sessionManager });
		expect(recoveryNotices(third)).toHaveLength(1);
		expect(third.session.delegationJournal.describe()).toEqual([]);
	});
});
