/**
 * The delegation journal: where a session's job history reaches disk, and the
 * only place it is read back.
 *
 * ## The gap this closes, and what OMP does instead
 *
 * OMP persists a child's *contract* — system prompt, tool grant, output schema —
 * in a `session_init` entry, and re-registers transcripts as `parked` or `aborted`
 * on restart. What it never persists is job state: the trace found `#jobs` is an
 * in-memory map with no `fs` import anywhere in `src/async/` and no journal entry
 * type for a job. OMP's own reviver admits the consequence — a child with no
 * message history fails to revive with "The agent was not revived."
 *
 * The concrete loss: a job settles, its result exists, and the process ends
 * before the parent collects it. The work is real and the answer is gone.
 *
 * ## What this journal is, and is not
 *
 * It records ids, labels, states, and result text. It never records a credential,
 * a child transcript, or a resumable agent — a process that died cannot resume an
 * in-memory child, so a job that was running when the journal was last written is
 * recovered as `interrupted` and reported as stopped. Nothing here can revive
 * anything, and nothing here pretends to.
 *
 * ## Where the records live
 *
 * In the session's own entry stream, as a `custom` entry per write. That is the
 * shape PrimePi already has (`SessionManager.appendCustomEntry`), so no new
 * on-disk format is invented here. Each write is a full snapshot of the journal
 * rather than a delta, so a torn or truncated final line degrades to the previous
 * snapshot instead of a half-applied one.
 *
 * ## Ownership
 *
 * Every snapshot carries the id of the session that wrote it, and a snapshot
 * written by another session is skipped rather than merged. One session's
 * recovery therefore cannot adopt, disturb, or overwrite another's — the same
 * guarantee OMP gets from `sessionFileBelongsToRoot` and its `owned` map, keyed
 * here on identity rather than on a path.
 */

import {
	describeRecovery,
	type PersistedJob,
	type RecoveredDelegation,
	recoverDelegation,
	reviveJob,
	toPersistedJob,
} from "./delegation-persistence.ts";
import type { JobRecord } from "./job-manager.js";

/** The custom entry type a delegation snapshot is written under. */
export const DELEGATION_JOURNAL_ENTRY_TYPE = "pi.delegation-journal";

/** Bumped only for a shape change that older readers cannot interpret. */
export const DELEGATION_JOURNAL_VERSION = 1;

/** The branch entry shape this module reads. */
export interface DelegationJournalEntry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/** One snapshot, as written to the session's entry stream. */
export interface DelegationJournalSnapshot {
	version: number;
	/** The session that wrote this snapshot. Never recovered by another. */
	sessionId: string;
	jobs: PersistedJob[];
}

export interface DelegationJournalHost {
	/** The session that owns this journal. */
	readonly sessionId: string;
	/** Branch entries, root first. */
	read(): readonly DelegationJournalEntry[];
	/** Appends one snapshot. May throw; the journal absorbs the failure. */
	write(snapshot: DelegationJournalSnapshot): void;
}

const EMPTY: RecoveredDelegation = { jobs: [], interruptedAgents: [] };

/**
 * The custom *message* entry type a recovery notice is written under.
 *
 * A message rather than a plain entry, because the notice exists to reach the
 * model: `convertToLlm` turns a `custom_message` into a `role: "user"` message,
 * so a parent learns its child was interrupted without having to ask. A `custom`
 * entry would sit in the session file and reach nobody.
 */
export const DELEGATION_RECOVERY_ENTRY_TYPE = "pi.delegation-recovery";

/** The details a recovery notice carries, so the notice is recognised on a later resume. */
export interface DelegationRecoveryNotice {
	version: number;
	/** The journal entry id this notice reports on. */
	source: string;
}

/**
 * Owns one session's delegation history.
 *
 * Writes are full snapshots of the current record set, ordered by the session's
 * own append-only stream, so the newest readable snapshot is the truth and an
 * unreadable one is skipped rather than allowed to empty the journal.
 */
export class DelegationJournal {
	readonly #host: DelegationJournalHost;
	/**
	 * Every job this session knows about, recovered and live alike.
	 *
	 * One map, because a job has one identity: its id. Whether a row came from a
	 * previous process is a question about provenance, not about the job, and
	 * holding two copies of one id is how a restart ends up reporting the same
	 * work twice under a live row and a dead one.
	 */
	readonly #records = new Map<string, PersistedJob>();
	/**
	 * Which of those ids came from a previous process.
	 *
	 * A live job reusing a recovered id drops out of this set, because the live
	 * generation is the current truth for that id and a stale outcome must not be
	 * reported under a name that now means different work.
	 */
	readonly #fromPreviousProcess = new Set<string>();
	#failure: string | undefined;

	constructor(host: DelegationJournalHost) {
		this.#host = host;
	}

	/**
	 * What a restart recovered.
	 *
	 * Empty until `load` runs, and empty again if it finds nothing this session
	 * owns. A journal that cannot be read is indistinguishable from one that was
	 * never written, which is the honest answer: neither is a claim about work.
	 *
	 * Recomputed rather than cached, so a result collected through the task tool
	 * stops being reported the moment it has been handed over.
	 */
	get recovered(): RecoveredDelegation {
		const jobs = [...this.#records.values()].filter((job) => this.#fromPreviousProcess.has(job.id));
		return jobs.length === 0 ? EMPTY : recoverDelegation({ jobs });
	}

	/**
	 * The last write's failure, or undefined.
	 *
	 * Kept because a silently dropped record is the exact loss this module
	 * exists to prevent. The previous snapshot survives a failed append — the
	 * stream is append-only — and the next write carries the newer state.
	 */
	get writeFailure(): string | undefined {
		return this.#failure;
	}

	/** Job ids a previous process used, for a host to claim before minting new ones. */
	get recoveredIds(): string[] {
		return [...this.#fromPreviousProcess];
	}

	/**
	 * Reads the newest snapshot this session owns off the branch.
	 *
	 * Returns the recovered view. Call once at startup, before new work is
	 * admitted, so a recovered id is claimed before it can be reissued.
	 */
	load(): RecoveredDelegation {
		const entries = this.#host.read();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== DELEGATION_JOURNAL_ENTRY_TYPE) continue;
			const data = entry.data;
			// A torn or truncated final line is what a crash mid-append leaves. It
			// is skipped rather than fatal: the previous snapshot is still a
			// truthful record, and discarding a whole journal over one bad line
			// would throw away work that is provably intact.
			if (!data || typeof data !== "object") continue;
			const snapshot = data as Partial<DelegationJournalSnapshot>;
			// An unrecognized version is a different shape, not a broken one, so
			// the scan stops rather than falling back to something older.
			if (snapshot.version !== DELEGATION_JOURNAL_VERSION) break;
			// Ownership is checked before anything is adopted: a snapshot stamped
			// with another session's id is skipped, so one session's recovery can
			// never adopt, surface, or deliver another's work.
			if (snapshot.sessionId !== this.#host.sessionId) continue;
			// A job list that is not a list is torn, and reading it as "no jobs"
			// would erase a journal that is unreadable rather than empty.
			if (snapshot.jobs !== undefined && !Array.isArray(snapshot.jobs)) continue;
			this.#records.clear();
			this.#fromPreviousProcess.clear();
			for (const raw of Array.isArray(snapshot.jobs) ? snapshot.jobs : []) {
				const job = reviveJob(raw);
				if (job) {
					this.#records.set(job.id, job);
					this.#fromPreviousProcess.add(job.id);
				}
			}
			break;
		}
		return this.recovered;
	}

	/**
	 * Records a live job's current state.
	 *
	 * Replaces any recovered record of the same id, because the live job is the
	 * current generation of that name.
	 */
	record(job: JobRecord): void {
		this.#fromPreviousProcess.delete(job.id);
		this.#store(toPersistedJob(job, job.agentId));
	}

	/**
	 * Marks a recovered job's result as collected.
	 *
	 * Returns false when the id is unknown or was already collected, so a second
	 * collection is visible rather than silent. The flag is what stops a restart
	 * from handing the parent a result it already has.
	 */
	markDelivered(id: string): boolean {
		const job = this.#records.get(id);
		if (!job || job.delivered) return false;
		this.#store({ ...job, delivered: true });
		return true;
	}

	/** The model- and operator-facing report for what was recovered. */
	describe(): string[] {
		return describeRecovery(this.recovered);
	}

	#store(job: PersistedJob): void {
		this.#records.set(job.id, job);
		// The record set stays authoritative in memory when the write fails, so
		// the next successful write carries the state this one could not.
		this.#write();
	}

	#write(): void {
		try {
			this.#host.write({
				version: DELEGATION_JOURNAL_VERSION,
				sessionId: this.#host.sessionId,
				jobs: [...this.#records.values()],
			});
			this.#failure = undefined;
		} catch (error) {
			this.#failure = error instanceof Error ? error.message : String(error);
		}
	}
}
