/**
 * Persisted delegation state, and what a restart may claim about it.
 *
 * ## The gap this closes
 *
 * OMP persists a child's *contract* — system prompt, tool grant, output schema —
 * in a `session_init` entry, and re-registers transcripts as `parked` or `aborted`
 * on restart. What it does not persist is any job state: the trace found
 * `#jobs` is an in-memory map with no `fs` import anywhere in `src/async/` and
 * no journal entry type for a job.
 *
 * The consequence is concrete. A crash between a job settling and its result
 * being injected leaves the result text only in process memory; the work survives
 * in the child's transcript, but the parent never learns of it. A clean
 * `dispose()` clears the map and has the same effect.
 *
 * ## The rule here
 *
 * **A process that died cannot resume an in-memory child, and must not pretend
 * to.** So a recovered job is never reported as running. A job that was in
 * flight when the journal was last written is recovered as `interrupted` — a
 * distinct state meaning "this was real work, and it stopped without finishing",
 * which is neither success nor failure and must not be reported as either.
 *
 * Terminal results are persisted the moment they are known, so a restart can
 * still deliver them. That is the specific loss OMP has.
 *
 * ## What is never persisted
 *
 * No credential, no key, no header, and no child transcript. Only ids, labels,
 * states, and result text that has already been through the caller's redaction.
 */

import type { AgentRef } from "./agent-registry.ts";
import type { JobRecord, JobState } from "./job-manager.js";

/**
 * A job's state as it is recoverable after a restart.
 *
 * `interrupted` is the state that does not exist in a live process: it means
 * the record was written while the job was still running, and the process ended
 * before it settled. Reporting that as `running` would manufacture an agent that
 * is not running; reporting it as `failed` would misattribute the cause.
 */
export type PersistedJobState = JobState | "interrupted";

/** One job's durable record. */
export interface PersistedJob {
	id: string;
	label: string;
	state: PersistedJobState;
	startedAt: number;
	settledAt?: number;
	/**
	 * The result, present once known.
	 *
	 * Persisted precisely because a result held only in memory is lost on a crash.
	 */
	result?: string;
	/** Why a recovered job is `interrupted`, for the operator. */
	note?: string;
	/** The child that ran it, when the job was a delegation. */
	agentId?: string;
	/** Whether the parent has been told. Survives a restart, so it is not retold. */
	delivered: boolean;
}

/** What a restart recovered. */
export interface RecoveredDelegation {
	jobs: PersistedJob[];
	/** Children that were running when the process ended. */
	interruptedAgents: { id: string; name: string }[];
}

/**
 * Builds the record for a settled job.
 *
 * Kept separate from the manager so the write shape is decided in one place and
 * can be asserted on directly, rather than inferred from a live job.
 */
export function toPersistedJob(job: JobRecord, agentId?: string): PersistedJob {
	return {
		id: job.id,
		label: job.label,
		state: job.state,
		startedAt: job.startedAt,
		...(job.settledAt !== undefined ? { settledAt: job.settledAt } : {}),
		...(job.result !== undefined ? { result: job.result } : {}),
		...(job.error !== undefined ? { note: job.error } : {}),
		...(agentId ? { agentId } : {}),
		delivered: job.delivered,
	};
}

/**
 * Normalizes a persisted job for use after a restart.
 *
 * A record whose state is `running` cannot be honoured: the process that owned it
 * is gone. It becomes `interrupted`, which is the honest description, and the
 * note says so rather than inventing a cause.
 */
export function reviveJob(record: unknown): PersistedJob | undefined {
	if (!record || typeof record !== "object") return undefined;
	const job = record as Partial<PersistedJob>;
	if (typeof job.id !== "string" || typeof job.label !== "string") return undefined;

	const wasRunning = job.state === "running";
	const state: PersistedJobState = wasRunning ? "interrupted" : ((job.state ?? "interrupted") as PersistedJobState);

	return {
		id: job.id,
		label: job.label,
		state,
		startedAt: typeof job.startedAt === "number" ? job.startedAt : 0,
		...(typeof job.settledAt === "number" ? { settledAt: job.settledAt } : {}),
		...(typeof job.result === "string" ? { result: job.result } : {}),
		...(typeof job.note === "string" ? { note: job.note } : {}),
		...(typeof job.agentId === "string" ? { agentId: job.agentId } : {}),
		delivered: job.delivered === true,
		// An interrupted job is, by definition, not yet delivered.
		...(wasRunning ? { note: job.note ?? "The process ended while this job was still running." } : {}),
	};
}

/**
 * Rebuilds the recoverable view from a persisted record.
 *
 * `interruptedAgents` is derived from the jobs rather than tracked separately,
 * so the two can never disagree: a child is interrupted exactly when a job
 * attributed to it was.
 */
export function recoverDelegation(record: unknown): RecoveredDelegation {
	const jobs: PersistedJob[] = [];
	if (record && typeof record === "object") {
		const raw = (record as { jobs?: unknown }).jobs;
		if (Array.isArray(raw)) {
			for (const entry of raw) {
				const job = reviveJob(entry);
				if (job) jobs.push(job);
			}
		}
	}

	const interruptedAgents = jobs
		.filter((job) => job.state === "interrupted" && job.agentId)
		.map((job) => ({ id: job.agentId as string, name: job.label }));

	return { jobs, interruptedAgents };
}

/** A child that was running when the process ended cannot be resumed. */
export function isRecoverableAgent(ref: Pick<AgentRef, "state">): boolean {
	// A recovered child is never `running`: the registry is in-memory, so nothing
	// survives a restart as running. The only states a recovered child can carry
	// are the terminal ones.
	return ref.state !== "running";
}

/**
 * A readable summary of recovered state, for the operator and for the model.
 *
 * Terminal results that were never delivered are surfaced first, because those
 * are the ones a restart would otherwise lose quietly. Interrupted work is listed
 * separately so it cannot be mistaken for either success or failure.
 */
export function describeRecovery(recovered: RecoveredDelegation): string[] {
	const lines: string[] = [];
	const undelivered = recovered.jobs.filter((job) => !job.delivered && job.state !== "interrupted");
	for (const job of undelivered) {
		lines.push(
			`Job ${job.id} (${job.label}) finished as ${job.state} before the result was delivered. ${job.result ?? ""}`.trim(),
		);
	}
	for (const job of recovered.jobs.filter((entry) => entry.state === "interrupted")) {
		lines.push(
			`Job ${job.id} (${job.label}) was still running when the session ended. ` +
				"It was interrupted and not resumed — the process that was running it is gone — " +
				`so the work has not completed and is not waiting on anything. ${job.note ?? ""}`.trim(),
		);
	}
	return lines;
}
