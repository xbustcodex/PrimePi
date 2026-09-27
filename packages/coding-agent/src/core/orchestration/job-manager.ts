/**
 * Background jobs: the minimum substrate for work that outlives a turn.
 *
 * ## What OMP does, and what this corrects
 *
 * OMP's `AsyncJobManager` is a process singleton whose `#jobs` map is explicitly
 * in-memory only — the trace found no write path to disk, so a restart loses
 * every row. It also exposes no `start`/`status`/`wait` by those names; the
 * caller reaches into `getJob(id).status`. And delivery is *retried* on failure
 * (`DELIVERY_RETRY_BASE_MS`), so duplicate suppression is generation-guarded
 * rather than idempotency-guarded.
 *
 * This is a deliberately small substrate, not a daemon or a launch broker:
 *
 *  - `start` returns a stable id immediately;
 *  - `status`/`list` report state without awaiting;
 *  - `wait` resolves on the terminal outcome;
 *  - `cancel` propagates into the running child.
 *
 * A result is delivered exactly once, enforced by a flag on the record rather
 * than by a retry policy, so there is no window in which a job could report the
 * same result twice.
 *
 * Job state is in-memory by design and says so: a background job does not
 * survive a process, and pretending otherwise would mean persisting a child
 * transcript, which is a much larger decision than this phase authorizes.
 */

/** A job's lifecycle. */
export type JobState = "running" | "completed" | "failed" | "cancelled";

/** A terminal job state. */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(["completed", "failed", "cancelled"]);

export function isTerminalJobState(state: JobState): boolean {
	return TERMINAL_JOB_STATES.has(state);
}

export interface JobRecord {
	/** Stable, opaque, monotonic. Never recycled. */
	id: string;
	label: string;
	state: JobState;
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms, present once terminal. */
	settledAt?: number;
	/** Present exactly once. */
	result?: string;
	/** Present on failure. */
	error?: string;
	/** True after the result has been handed to the caller. */
	delivered: boolean;
}

/** A handle on a running job. */
export interface JobHandle {
	readonly id: string;
	/** Resolves the terminal outcome. Never rejects: a failure is a value. */
	wait(): Promise<JobState>;
	/** Aborts the running work. Returns false once already terminal. */
	cancel(): boolean;
}

export interface JobManagerOptions {
	/** Maximum jobs that may run at once. Further `start` calls are refused. */
	maxRunning?: number;
	now?: () => number;
}

/**
 * Tracks background jobs for one session.
 *
 * One instance per session, owned by whoever owns the `TaskRunner`. Not a global
 * singleton: OMP's is, and that is why its job rows can outlive the session that
 * created them.
 */
export class JobManager {
	readonly #jobs = new Map<string, JobRecord>();
	readonly #controllers = new Map<string, AbortController>();
	readonly #settled = new Map<string, Promise<JobState>>();
	readonly #maxRunning: number;
	readonly #now: () => number;
	#counter = 0;

	constructor(options: JobManagerOptions = {}) {
		this.#maxRunning = options.maxRunning ?? 8;
		this.#now = options.now ?? Date.now;
	}

	/** Jobs currently running. */
	get runningCount(): number {
		return this.list().filter((job) => job.state === "running").length;
	}

	/**
	 * Starts background work and returns a handle immediately.
	 *
	 * `signal` is aborted when the job is cancelled, so the work can stop at a
	 * point of its own choosing rather than being killed from outside.
	 */
	start(label: string, run: (input: { signal: AbortSignal; jobId: string }) => Promise<string>): JobHandle {
		if (this.runningCount >= this.#maxRunning) {
			throw new Error(`Background job limit reached (${this.#maxRunning}). Wait for a job to finish or cancel one.`);
		}

		this.#counter += 1;
		// Monotonic and never recycled, so a stale id cannot name a new job.
		const id = `job-${this.#counter}`;
		const controller = new AbortController();

		this.#jobs.set(id, { id, label, state: "running", startedAt: this.#now(), delivered: false });
		this.#controllers.set(id, controller);

		const settled = (async (): Promise<JobState> => {
			const record = this.#jobs.get(id);
			if (!record) return "failed";
			try {
				if (controller.signal.aborted) {
					this.#finish(id, "cancelled", undefined, "Job was cancelled.");
					return "cancelled";
				}
				const result = await run({ signal: controller.signal, jobId: id });
				// A job whose work threw after cancellation is a cancellation, not a
				// failure, so the two are never conflated.
				if (controller.signal.aborted) {
					this.#finish(id, "cancelled", undefined, "Job was cancelled.");
					return "cancelled";
				}
				this.#finish(id, "completed", result);
				return "completed";
			} catch (error) {
				if (controller.signal.aborted) {
					this.#finish(id, "cancelled", undefined, "Job was cancelled.");
					return "cancelled";
				}
				this.#finish(id, "failed", undefined, error instanceof Error ? error.message : String(error));
				return "failed";
			} finally {
				this.#controllers.delete(id);
			}
		})();

		this.#settled.set(id, settled);
		return {
			id,
			wait: () => settled,
			cancel: () => this.cancel(id),
		};
	}

	/** A snapshot of one job, or undefined when unknown. */
	status(id: string): JobRecord | undefined {
		const record = this.#jobs.get(id);
		return record ? { ...record } : undefined;
	}

	/** Every job, in start order. */
	list(): JobRecord[] {
		return [...this.#jobs.values()].map((record) => ({ ...record }));
	}

	/**
	 * Cancels a job.
	 *
	 * The signal is aborted first so the work can observe it, and the record is
	 * settled immediately so a caller awaiting the result is never left hanging on
	 * work that ignored its signal.
	 */
	cancel(id: string, reason = "Job was cancelled."): boolean {
		const record = this.#jobs.get(id);
		if (!record || isTerminalJobState(record.state)) return false;
		this.#controllers.get(id)?.abort();
		this.#finish(id, "cancelled", undefined, reason);
		return true;
	}

	/**
	 * Cancels every running job.
	 *
	 * Returns the ids settled, so a session shutdown can assert that nothing was
	 * left running.
	 */
	cancelAll(reason = "Session ended."): string[] {
		const ids: string[] = [];
		for (const record of this.list()) {
			if (record.state === "running" && this.cancel(record.id, reason)) ids.push(record.id);
		}
		return ids;
	}

	/**
	 * Awaits every job's terminal state.
	 *
	 * Resolves rather than rejects: a job's failure is an outcome, not an error
	 * for the session to handle.
	 */
	async waitForAll(): Promise<JobState[]> {
		return Promise.all([...this.#settled.values()]);
	}

	/**
	 * Marks a job's result as handed to the caller.
	 *
	 * Returns false on a second call, so a duplicated delivery is observable
	 * rather than silent. Nothing here retries: a result is delivered once or not
	 * at all, which is the property OMP's retry policy cannot give.
	 */
	markDelivered(id: string): boolean {
		const record = this.#jobs.get(id);
		if (!record || record.delivered) return false;
		record.delivered = true;
		return true;
	}

	/** Drops a terminal job. Refuses a running one. */
	forget(id: string): boolean {
		const record = this.#jobs.get(id);
		if (!record || !isTerminalJobState(record.state)) return false;
		this.#jobs.delete(id);
		this.#settled.delete(id);
		return true;
	}

	#finish(id: string, state: JobState, result?: string, error?: string): void {
		const record = this.#jobs.get(id);
		if (!record || isTerminalJobState(record.state)) return;
		record.state = state;
		record.settledAt = this.#now();
		// Only assigned once, so a result cannot be overwritten by a late arrival.
		if (result !== undefined && record.result === undefined) record.result = result;
		if (error !== undefined && record.error === undefined) record.error = error;
	}
}
