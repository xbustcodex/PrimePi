/**
 * Checkpoint and rewind: bounding exploration without losing its findings.
 *
 * ## The problem
 *
 * An agent investigating an unfamiliar codebase accumulates a lot of context -
 * files read, greps run, dead ends explored. When it finally understands the
 * problem, most of that context is noise, and the valuable part is the few
 * conclusions it drew.
 *
 * Rewinding to before the investigation keeps the conclusions and discards the
 * path. That is only worth doing if the conclusions are written down first,
 * which is the whole design.
 *
 * ## Why rewind requires a report
 *
 * A rewind discards the transcript that produced the understanding. A model that
 * rewinds without writing anything has thrown away both the exploration *and*
 * what it learned, and is left reasoning from nothing with a smaller context
 * than it started with.
 *
 * So the report is not documentation. It is the *only* thing that survives, and
 * requiring one makes the loss bounded and the gain real.
 *
 * ## One checkpoint at a time
 *
 * A second checkpoint while one is active is an error rather than a nesting.
 * Nested checkpoints have no coherent rewind target: rewinding to the inner one
 * discards the outer one's work, and rewinding to the outer discards the inner's.
 * The error names the condition so the model can finish rather than guess.
 *
 * ## Rewind is bounded by the session tree, not by message count
 *
 * A checkpoint records a **session entry id**, not a message offset, so a rewind
 * can rejoin the tree at the right place even when entries have been added,
 * pruned or rewritten since. An index into a mutable array would drift.
 *
 * ## Destructive by construction
 *
 * Rewind is irreversible. That is why the report is mandatory and why the
 * resulting state records when the rewind happened, rather than pretending it
 * can be undone.
 */

/** A checkpoint, and the session position it names. */
export interface CheckpointState {
	/** In-memory messages at the checkpoint, after the checkpoint result is appended. */
	readonly checkpointMessageCount: number;
	/** The session entry the rewind rejoins at. Null when the session has no tree. */
	readonly checkpointEntryId: string | null;
	/** When the checkpoint was taken. */
	readonly startedAt: string;
	/** The investigation goal, carried into the report. */
	readonly goal: string;
}

/** What a rewind produced, retained after it succeeds. */
export interface CompletedRewindState {
	/** The findings the model wrote before rewinding. This is what survived. */
	readonly report: string;
	readonly rewoundAt: string;
	/** The checkpoint that was rewound to. */
	readonly checkpoint: CheckpointState;
}

export type CheckpointOutcome =
	| { readonly ok: true; readonly state: CheckpointState; readonly message: string }
	| { readonly ok: false; readonly reason: string };

export type RewindOutcome =
	| { readonly ok: true; readonly state: CompletedRewindState; readonly message: string }
	| { readonly ok: false; readonly reason: "no-checkpoint" | "empty-report" | "already-rewound" };

/** Tracks at most one active checkpoint per session. */
export class CheckpointController {
	#active: CheckpointState | undefined;
	#completed: CompletedRewindState | undefined;

	/** The active checkpoint, if any. */
	get active(): CheckpointState | undefined {
		return this.#active;
	}

	/** The most recent completed rewind, if any. */
	get lastRewind(): CompletedRewindState | undefined {
		return this.#completed;
	}

	/**
	 * Takes a checkpoint.
	 *
	 * A second one is refused rather than nested: nested checkpoints have no
	 * coherent rewind target, because rewinding to the inner discards the outer
	 * work and rewinding to the outer discards the inner's.
	 */
	checkpoint(input: { goal: string; nowMs: number; messageCount: number; entryId: string | null }): CheckpointOutcome {
		if (this.#active) {
			return { ok: false, reason: "Checkpoint already active." };
		}
		const goal = input.goal.trim();
		if (goal.length === 0) {
			// A checkpoint with no goal records nothing about what was being explored,
			// so the rewind would have no context to report against.
			return { ok: false, reason: "A checkpoint needs a goal." };
		}
		const state: CheckpointState = {
			checkpointMessageCount: input.messageCount,
			checkpointEntryId: input.entryId,
			startedAt: new Date(input.nowMs).toISOString(),
			goal,
		};
		this.#active = state;
		return {
			ok: true,
			state,
			message: `Checkpoint: ${goal}\nFinish exploration and formulate findings.`,
		};
	}

	/**
	 * Rewinds to the active checkpoint, keeping the written report.
	 *
	 * The report is mandatory. A rewind discards the transcript that produced the
	 * understanding, so a model that rewinds without writing anything has thrown
	 * away both the exploration and what it learned.
	 */
	rewind(input: { report: string; nowMs: number }): RewindOutcome {
		const checkpoint = this.#active;
		if (!checkpoint) return { ok: false, reason: "no-checkpoint" };
		const report = input.report.trim();
		if (report.length === 0) {
			// Named explicitly, because "rewind" with an empty report looks like a
			// successful rewind and silently discards the exploration.
			return { ok: false, reason: "empty-report" };
		}
		const state: CompletedRewindState = {
			report,
			rewoundAt: new Date(input.nowMs).toISOString(),
			checkpoint,
		};
		this.#active = undefined;
		this.#completed = state;
		return {
			ok: true,
			state,
			message: `Rewound to ${checkpoint.startedAt}. Findings kept:\n${report}`,
		};
	}

	/**
	 * Where a resumed session rejoins the tree.
	 *
	 * A checkpoint records an entry id rather than a message offset, so the rejoin
	 * survives entries being added, pruned or rewritten since. An index into a
	 * mutable array drifts, and a drifted rejoin is a rewind to the wrong place.
	 */
	rejoinTarget(): string | null {
		return this.#active?.checkpointEntryId ?? null;
	}

	/** Discards the active checkpoint without rewinding, for an abort. */
	abandon(): boolean {
		if (!this.#active) return false;
		this.#active = undefined;
		return true;
	}
}
