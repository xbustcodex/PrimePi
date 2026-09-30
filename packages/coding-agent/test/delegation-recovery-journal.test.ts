import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	DELEGATION_JOURNAL_ENTRY_TYPE,
	DelegationJournal,
	type DelegationJournalEntry,
	type DelegationJournalSnapshot,
} from "../src/core/orchestration/delegation-journal.ts";
import { JobManager } from "../src/core/orchestration/job-manager.ts";
import { TaskRunner } from "../src/core/orchestration/task-runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTaskTool, type TaskOperations } from "../src/core/tools/task.ts";

/**
 * Delegated-child crash recovery, driven through the production path.
 *
 * A "process" here is the real substrate wired to a real journal over a real
 * entry stream: `JobManager` -> `onChange` -> `DelegationJournal` -> session
 * entries, and on the other side `DelegationJournal.load()` -> the `task` tool.
 * The terminate boundary is modelled the only honest way available in-process:
 * the first process is dropped without being disposed, and a second one is
 * constructed over the same entries with a fresh `JobManager` and registry.
 *
 * The property under test is what a restart is allowed to claim. A process that
 * died cannot resume an in-memory child, so a recovered job is never reported as
 * running, work that stopped without finishing is reported as `interrupted`
 * rather than as success or failure, and a record written by another session is
 * never adopted.
 */

const PAID = { id: "vendor/paid-1", provider: "vendor" } as unknown as Model<Api>;

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegation-recovery-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** One process's view of the delegation substrate, wired the way a session wires it. */
interface Process {
	journal: DelegationJournal;
	jobs: JobManager;
	ops: TaskOperations;
	/** Ids this process handed out, so a test can assert one was never recycled. */
	ids: string[];
	/** Toggled mid-process, standing in for a disk that fills up and frees again. */
	disk: { failing: boolean };
}

function openProcess(options: {
	sessionId: string;
	read: () => readonly DelegationJournalEntry[];
	write: (snapshot: DelegationJournalSnapshot) => void;
	/** Tasks whose work never settles, so the job is still running at process end. */
	hang?: (task: string) => boolean;
}): Process {
	const disk = { failing: false };
	const journal = new DelegationJournal({
		sessionId: options.sessionId,
		read: options.read,
		write: (snapshot) => {
			if (disk.failing) throw new Error("ENOSPC: no space left on device");
			options.write(snapshot);
		},
	});
	// The startup read, and the id claim that follows it: a recovered id must not
	// be handed out again, or `job-1` would name two different pieces of work.
	const recovered = journal.load();
	const jobs = new JobManager({
		onChange: (job) => journal.record(job),
		claimIds: recovered.jobs.map((job) => job.id),
	});
	const runner = new TaskRunner({
		gate: { parentTools: ["read"], beforeToolCall: async () => undefined },
		getSessionModel: () => PAID,
		resolveModel: async () => ({ model: PAID }),
		// The production wiring: a child is named on its job at registration, which
		// is the only moment a child that dies with the process can be identified.
		onSpawn: ({ childId, jobId }) => {
			if (jobId) jobs.attachAgent(jobId, childId);
		},
		run: async (input) => {
			if (options.hang?.(input.definition.task)) return new Promise<string>(() => {});
			return `done: ${input.definition.task}`;
		},
	});
	const ids: string[] = [];
	const ops: TaskOperations = {
		runner,
		jobs: {
			list: () => jobs.list(),
			status: (id) => jobs.status(id),
			wait: async (id) => ((await jobs.waitById(id)) === undefined ? undefined : (jobs.status(id)?.result ?? "")),
			cancel: (id) => jobs.cancel(id),
			start: (label, run) => {
				const handle = jobs.start(label, run);
				ids.push(handle.id);
				return handle;
			},
			markDelivered: (id) => jobs.markDelivered(id),
			recovered: () => journal.recovered,
			markRecoveredDelivered: (id) => journal.markDelivered(id),
			writeError: () => journal.writeFailure,
		},
		runChild: (request) => runner.run(request),
		parentTools: () => ["read"],
	};
	return { journal, jobs, ops, ids, disk };
}

/** Calls the tool the way the agent runtime does. */
async function call(
	ops: TaskOperations,
	params: Record<string, unknown>,
): Promise<{ content: { text: string }[]; details: Record<string, unknown> }> {
	const tool = createTaskTool(ops);
	return (
		tool.execute as unknown as (
			id: string,
			p: unknown,
			signal: AbortSignal,
		) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>
	)("call-1", params, new AbortController().signal);
}

describe("delegated-child crash recovery", () => {
	it("recovers a settled result the previous process never delivered", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write });
		const started = await call(first.ops, { op: "run", agent: "coder", task: "fix it", background: true });
		const jobId = String((started.details as { job: { id: string } }).job.id);
		await first.jobs.waitForAll();
		// The process ends here without the parent ever collecting the result.
		// That is the loss this closes: the answer exists, in memory, and is gone.

		const second = openProcess({ sessionId: "s1", read, write });
		const collected = await call(second.ops, { op: "result", jobId });
		expect(collected.content[0].text).toBe("done: fix it");
		// Delivery is recorded, so a second restart does not retell a result the
		// parent already has.
		expect(second.journal.describe()).toEqual([]);
	});

	it("reports work that was still running as interrupted, and refuses to resume it", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write, hang: () => true });
		const started = await call(first.ops, { op: "run", agent: "coder", task: "long work", background: true });
		const jobId = String((started.details as { job: { id: string } }).job.id);
		expect(first.jobs.status(jobId)?.state).toBe("running");

		const second = openProcess({ sessionId: "s1", read, write });
		const status = await call(second.ops, { op: "status", jobId });
		expect(status.content[0].text).toContain("is interrupted");
		// Claiming the state is not enough: nothing may present it as live.
		expect(status.content[0].text).toContain("is not running");
		// The child that was mid-flight is named, so a restart can say whose work
		// stopped rather than only that some work stopped.
		expect(second.journal.recovered.interruptedAgents).toEqual([{ id: "agent-1", name: "coder" }]);
		const agents = await call(second.ops, { op: "agents" });
		expect(agents.content[0].text).toContain("coder (job job-1)");
		expect(agents.content[0].text).toContain("not resumable");

		const result = await call(second.ops, { op: "result", jobId });
		expect(result.content[0].text).toContain("still running when the session ended");
		expect(result.content[0].text).toContain("has not completed");

		const cancelled = await call(second.ops, { op: "cancel", jobId });
		expect(cancelled.content[0].text).toContain("already stopped");
		expect(cancelled.content[0].text).toContain("cannot be resumed");
		// A cancellation that claimed success would be a claim about a child that
		// no longer exists, so the job must still read as interrupted afterwards.
		expect((await call(second.ops, { op: "status", jobId })).content[0].text).toContain("is interrupted");
	});

	it("never recycles a recovered id for a new job", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write, hang: () => true });
		await call(first.ops, { op: "run", agent: "coder", task: "long work", background: true });

		const second = openProcess({ sessionId: "s1", read, write });
		await call(second.ops, { op: "run", agent: "reviewer", task: "new work", background: true });
		// `job-1` still names the stopped work; the new job cannot claim it.
		expect(second.ids).toEqual(["job-2"]);
		const status = await call(second.ops, { op: "status", jobId: "job-1" });
		expect(status.content[0].text).toContain("coder");
		expect(status.content[0].text).toContain("is interrupted");
	});

	it("recovers several jobs with their own outcomes, in start order", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write, hang: (task) => task === "two" });
		await call(first.ops, { op: "run", agent: "coder", task: "one", background: true });
		await first.jobs.waitForAll();
		await call(first.ops, { op: "run", agent: "reviewer", task: "two", background: true });

		const second = openProcess({ sessionId: "s1", read, write });
		const jobs = await call(second.ops, { op: "jobs" });
		expect(jobs.content[0].text).toContain("job-1 (coder) completed");
		// A job that was still running comes back interrupted, in place and in
		// start order, rather than being dropped or promoted to a result.
		expect(jobs.content[0].text).toContain("job-2 (reviewer) interrupted");
		expect((await call(second.ops, { op: "result", jobId: "job-1" })).content[0].text).toBe("done: one");
	});

	it("does not report a clean shutdown as a crash", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write, hang: () => true });
		await call(first.ops, { op: "run", agent: "coder", task: "long work", background: true });
		// A session that shuts down cleanly cancels its jobs on the way out, the
		// same call `AgentSession.dispose` makes. That is a different fact from a
		// process that died, and conflating them would make every ordinary exit
		// read as a crash.
		expect(first.jobs.cancelAll("Session was disposed.")).toEqual(["job-1"]);

		const second = openProcess({ sessionId: "s1", read, write });
		expect(second.journal.recovered.jobs[0]?.state).toBe("cancelled");
		// An interrupted job names a child that cannot be resumed. A cancelled one
		// must not be reported that way, or the parent is told to redo work that
		// was deliberately stopped.
		expect(second.journal.recovered.interruptedAgents).toEqual([]);
		// The parent still learns the job was cancelled, but nothing tells it the
		// work was interrupted or that it must be started again.
		const [line] = second.journal.describe();
		expect(line).toContain("cancelled");
		expect(line).not.toMatch(/still running|interrupted|not completed/i);
	});

	it("recovers nothing from an empty journal, and says so", async () => {
		const entries: DelegationJournalEntry[] = [];
		const process = openProcess({ sessionId: "s1", read: () => entries, write: () => {} });
		expect(process.journal.recovered).toEqual({ jobs: [], interruptedAgents: [] });
		const jobs = await call(process.ops, { op: "jobs" });
		expect(jobs.content[0].text).toBe("No background jobs.");
	});

	it("falls back to the last readable snapshot when the newest record is malformed", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const first = openProcess({ sessionId: "s1", read, write });
		await call(first.ops, { op: "run", agent: "coder", task: "one", background: true });
		await first.jobs.waitForAll();

		// A torn or truncated final line, which is what a crash mid-append leaves.
		entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: { version: 1 } });
		entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: "not-an-object" });
		entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE });

		const second = openProcess({ sessionId: "s1", read, write });
		expect((await call(second.ops, { op: "result", jobId: "job-1" })).content[0].text).toBe("done: one");
	});

	it("ignores a journal written by a different session", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const foreign = openProcess({ sessionId: "s-other", read, write });
		await call(foreign.ops, { op: "run", agent: "coder", task: "someone else's work", background: true });
		await foreign.jobs.waitForAll();

		// Same entry stream, different session. One session's recovery must not
		// adopt, surface, or deliver another's work.
		const mine = openProcess({ sessionId: "s-mine", read, write });
		expect(mine.journal.recovered.jobs).toEqual([]);
		expect((await call(mine.ops, { op: "jobs" })).content[0].text).toBe("No background jobs.");
		expect(mine.jobs.status("job-1")).toBeUndefined();
		// And the first session still owns its own record.
		expect(openProcess({ sessionId: "s-other", read, write }).journal.recovered.jobs).toHaveLength(1);
	});

	it("keeps the previous record when a write fails, and reports the failure", async () => {
		const entries: DelegationJournalEntry[] = [];
		const read = () => entries;
		const write = (snapshot: DelegationJournalSnapshot) =>
			entries.push({ type: "custom", customType: DELEGATION_JOURNAL_ENTRY_TYPE, data: snapshot });

		const process = openProcess({ sessionId: "s1", read, write });
		await call(process.ops, { op: "run", agent: "coder", task: "one", background: true });
		await process.jobs.waitForAll();
		const entriesBefore = entries.length;

		// The disk refuses from here on. A job still settles; only the record is
		// lost, and it must be lost without disturbing what is already there.
		process.disk.failing = true;
		const started = await call(process.ops, { op: "run", agent: "reviewer", task: "two", background: true });
		const jobId = String((started.details as { job: { id: string } }).job.id);
		await process.jobs.waitForAll();
		expect(process.jobs.status(jobId)?.state).toBe("completed");
		// The append-only stream is exactly as it was: nothing torn, nothing
		// truncated, and the earlier record still readable.
		expect(entries.length).toBe(entriesBefore);
		expect(process.journal.writeFailure).toContain("ENOSPC");

		// The loss is reported rather than silent, because a record the disk
		// refused is exactly the record a restart would not know about.
		const jobs = await call(process.ops, { op: "jobs" });
		expect(jobs.content[0].text).toContain("could not be written");
		expect(jobs.details.journalError).toContain("ENOSPC");

		// When the disk recovers, the next write carries the record that failed —
		// the outage cost the interval, not the work.
		process.disk.failing = false;
		await call(process.ops, { op: "run", agent: "auditor", task: "three", background: true });
		await process.jobs.waitForAll();
		expect(process.journal.writeFailure).toBeUndefined();

		const restarted = openProcess({ sessionId: "s1", read, write });
		expect(restarted.journal.recovered.jobs.map((job) => job.id)).toEqual(["job-1", "job-2", "job-3"]);
		expect((await call(restarted.ops, { op: "status", jobId })).content[0].text).toContain("reviewer");
	});

	it("writes through a real session file and reads it back after a restart", async () => {
		const dir = tempDir();
		const session = SessionManager.create(dir, dir);
		// The session file is only flushed once the session has an assistant turn,
		// so the record below is written to disk exactly as a real session's would.
		session.appendMessage(fauxAssistantMessage("earlier turn"));

		const entries = () => session.getBranch();
		const first = openProcess({
			sessionId: session.getSessionId(),
			read: entries,
			write: (snapshot) => {
				session.appendCustomEntry(DELEGATION_JOURNAL_ENTRY_TYPE, snapshot);
			},
		});
		await call(first.ops, { op: "run", agent: "coder", task: "on disk", background: true });
		await first.jobs.waitForAll();

		// A restart: the file is re-read from disk by a fresh manager, exactly as
		// a new process would.
		const reopened = SessionManager.open(session.getSessionFile() as string, undefined, dir);
		const second = openProcess({
			sessionId: reopened.getSessionId(),
			read: () => reopened.getBranch(),
			write: (snapshot) => {
				reopened.appendCustomEntry(DELEGATION_JOURNAL_ENTRY_TYPE, snapshot);
			},
		});
		expect(second.journal.recovered.jobs).toHaveLength(1);
		expect((await call(second.ops, { op: "result", jobId: "job-1" })).content[0].text).toBe("done: on disk");
	});
});
