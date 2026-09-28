import { describe, expect, it } from "vitest";
import {
	describeRecovery,
	isRecoverableAgent,
	recoverDelegation,
	reviveJob,
	toPersistedJob,
} from "../src/core/orchestration/delegation-persistence.ts";
import { JobManager } from "../src/core/orchestration/job-manager.ts";

/**
 * Restart recovery determinism.
 *
 * The property under test: what a restart is allowed to claim. A process that
 * died cannot resume an in-memory child, so a recovered job must never be
 * reported as running, and work that stopped without finishing must be reported
 * as `interrupted` rather than as either success or failure. The specific loss
 * this closes is OMP's — a settled result living only in process memory and
 * being lost on a crash before delivery.
 */

const RUNNING = {
	id: "job-1",
	label: "coder",
	state: "running" as const,
	startedAt: 1_000,
	delivered: false,
};

describe("delegation restart recovery", () => {
	it("persists a terminal result so a crash after settlement does not lose it", () => {
		// This is the case OMP loses: the work finished, but the result text was
		// in process memory only, so a crash before delivery dropped it.
		const settled = toPersistedJob(
			{ ...RUNNING, state: "completed", result: "the answer", settledAt: 2_000 },
			"agent-1",
		);
		const recovered = recoverDelegation({ version: 1, jobs: [settled] });
		const job = recovered.jobs.find((entry) => entry.id === "job-1");
		expect(job?.state).toBe("completed");
		expect(job?.result).toBe("the answer");
	});

	it("recovers an in-flight job as interrupted, never as running", () => {
		// A job recorded as running cannot be resumed after a restart — the
		// process that held it is gone. Reporting it as running would be a lie the
		// model could act on.
		const persisted = toPersistedJob(RUNNING, "agent-1");
		expect(persisted.state).toBe("running");
		const recovered = recoverDelegation({ version: 1, jobs: [persisted] });
		const job = recovered.jobs.find((entry) => entry.id === "job-1");
		expect(job?.state).toBe("interrupted");
		expect(recovered.jobs.some((entry) => entry.state === "running")).toBe(false);
	});

	it("keeps a terminal result even when the agent it belonged to is gone", () => {
		// The work is real and the result is known; losing it because the child
		// record was pruned would repeat the exact failure being fixed.
		const recovered = recoverDelegation({
			version: 1,
			jobs: [{ ...toPersistedJob({ ...RUNNING, state: "completed", result: "kept" }), agentId: "dead-agent" }],
		});
		expect(recovered.jobs[0]?.result).toBe("kept");
	});

	it("never reports a recovered child as still running", () => {
		// Only a terminal child is recoverable. A running one is evidence of work
		// that stopped, which is a different thing.
		expect(isRecoverableAgent({ state: "running" })).toBe(false);
		expect(isRecoverableAgent({ state: "completed" })).toBe(true);
		expect(isRecoverableAgent({ state: "failed" })).toBe(true);
		expect(isRecoverableAgent({ state: "cancelled" })).toBe(true);
	});

	it("is deterministic: the same journal always recovers the same state", async () => {
		const journal = {
			version: 1,
			jobs: [
				toPersistedJob(RUNNING, "agent-1"),
				toPersistedJob({ ...RUNNING, id: "job-2", state: "completed", result: "two" }, "agent-2"),
			],
		};
		const first = recoverDelegation(journal);
		const second = recoverDelegation(JSON.parse(JSON.stringify(journal)));
		// Recovery feeds both a human report and the model's context, so two
		// reads of the same journal must not differ.
		expect(second).toEqual(first);
		expect(describeRecovery(second)).toEqual(describeRecovery(first));
	});

	it("survives a round trip through JSON unchanged", () => {
		// The journal is written to disk, so anything JSON drops — undefined,
		// Dates, class instances — would be lost state.
		const record = toPersistedJob({ ...RUNNING, state: "completed", result: "r" }, "agent-1");
		const roundTripped = reviveJob(JSON.parse(JSON.stringify(record)));
		expect(roundTripped).toEqual(record);
	});

	it("rejects a malformed record rather than inventing one", () => {
		expect(reviveJob(undefined)).toBeUndefined();
		expect(reviveJob(null)).toBeUndefined();
		expect(reviveJob({})).toBeUndefined();
		// A record with an id but no label cannot be rendered honestly.
		expect(reviveJob({ id: "x", state: "running" })).toBeUndefined();
		expect(reviveJob("nope")).toBeUndefined();
	});

	it("tolerates a corrupt or truncated journal instead of failing the session", () => {
		// A session must still open if its delegation journal is damaged. An
		// unreadable journal means unknown delegation state, which is reported as
		// such rather than crashing the restore path.
		const recovered = recoverDelegation({ version: 1, jobs: [{ nonsense: true }, null] });
		expect(recovered.jobs).toEqual([]);
		expect(recovered.interruptedAgents).toEqual([]);
	});

	it("describes interrupted work distinctly from success and failure", () => {
		const recovered = recoverDelegation({
			version: 1,
			jobs: [
				toPersistedJob(RUNNING, "agent-1"),
				toPersistedJob({ ...RUNNING, id: "job-2", state: "completed", result: "ok" }, "agent-2"),
			],
		});
		const lines = describeRecovery(recovered);
		const interruptedLine = lines.find((line) => line.includes("job-1"));
		expect(interruptedLine).toBeDefined();
		// The interrupted job must not be described as having finished.
		expect(interruptedLine).not.toMatch(/finished as (completed|succeeded)|succeeded/i);
		expect(interruptedLine).toMatch(/has not completed|still running/i);
		// The completed one keeps its result so a restart can still deliver it.
		expect(lines.some((line) => line.includes("job-2") && line.includes("ok"))).toBe(true);
	});

	it("delivers a recovered terminal result through the live job manager", async () => {
		// The point of persisting: a restart can re-offer a result the parent
		// never received, rather than the work being silently lost.
		const jobs = new JobManager();
		const persisted = toPersistedJob({ ...RUNNING, state: "completed", result: "recovered answer" }, "agent-1");
		const revived = reviveJob(persisted);
		expect(revived).toBeDefined();
		if (!revived) return;

		const handle = jobs.start("recovered", async () => revived.result ?? "");
		await handle.wait();
		expect(jobs.status(handle.id)?.result).toBe("recovered answer");
	});
});
