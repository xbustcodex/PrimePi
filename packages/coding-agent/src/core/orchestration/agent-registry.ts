/**
 * Agent registry: identity, hierarchy, and lifecycle.
 *
 * ## What OMP does, and the two problems this corrects
 *
 * OMP has **no single task-state enum**. Four vocabularies describe one run:
 * `AgentStatus` (4 values), `AgentProgress.status` (5), `AbortReason` (5), and
 * `AsyncJob.status` (4), plus ad-hoc `exitCode`/`aborted`/`error` booleans on
 * `SingleResult`. Identity is a single hierarchical dotted string that doubles as
 * the registry key, the AsyncJob id, the transcript stem, and the artifact name,
 * so one concept carries four meanings and changing a name changes all of them.
 *
 * This uses one state union per concern and keeps identity opaque: an id is
 * generated here and is never parsed. A caller that needs a display name gets one
 * field, not a string split on dots.
 *
 * ## The states
 *
 * `queued → running → (completed | failed | cancelled | timed-out)` is the whole
 * lifecycle, plus `rejected` for a child that never started. The terminal set is
 * closed: `TERMINAL_STATES`. Once terminal, a state is immutable — OMP gets this
 * for one case only (`aborted` is sticky, `agent-registry.ts:183-186`) and by
 * convention elsewhere. Here it is a type-level property, so a completed child
 * cannot be resurrected by a late completion or a retry.
 */

/** A run's lifecycle state. */
export type AgentState =
	/** Accepted and waiting for a concurrency permit. */
	| "queued"
	/** Executing. */
	| "running"
	/** Finished successfully; a result is available. */
	| "completed"
	/** Finished unsuccessfully; an error is recorded. */
	| "failed"
	/** Stopped by an explicit cancellation. */
	| "cancelled"
	/** Stopped by exceeding a runtime limit. */
	| "timed-out"
	/** Never started, because admission refused it. */
	| "rejected";

/** States from which no further transition is permitted. */
export const TERMINAL_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
	"completed",
	"failed",
	"cancelled",
	"timed-out",
	"rejected",
]);

export function isTerminalAgentState(state: AgentState): boolean {
	return TERMINAL_AGENT_STATES.has(state);
}

/** Why a child ended the way it did. Distinct from *how* it was stopped. */
export type AgentOutcomeReason =
	| "completed"
	| "child-error"
	| "cancelled-by-parent"
	| "cancelled-by-caller"
	| "runtime-limit"
	| "depth-limit"
	| "concurrency-limit"
	| "tool-denied"
	| "preflight-rejected";

/** A terminal outcome, recorded once and never mutated. */
export interface AgentOutcome {
	state: Extract<AgentState, "completed" | "failed" | "cancelled" | "timed-out" | "rejected">;
	reason: AgentOutcomeReason;
	/** Human-readable detail. Never a credential: results are redacted before entry. */
	message?: string;
	/** Epoch ms. */
	at: number;
}

/** Static description of what a child is allowed to do. */
export interface AgentDefinition {
	/** Stable name, unique per registry. */
	name: string;
	/** One-line summary shown to the parent. */
	description: string;
	/**
	 * System prompt for the child.
	 *
	 * Stored here rather than discovered from disk so a definition is a plain value:
	 * it can be compared, asserted on, and passed across a process boundary without
	 * a filesystem lookup.
	 */
	systemPrompt: string;
	/**
	 * Tool names this child may use.
	 *
	 * Interpreted as a ceiling, never a grant: the effective set is intersected
	 * with the parent's, so a definition can only narrow. See `narrowToolNames`.
	 */
	tools?: readonly string[];
	/**
	 * Model role this child prefers, e.g. `"smol"`.
	 *
	 * A preference, not a grant. It is resolved through the role chain and then
	 * through Pi's eligibility authorities, so a role naming a paid model cannot
	 * escape a free-only session.
	 */
	modelRole?: string;
	/** Depth at which this definition may no longer spawn children. */
	maxDepth?: number;
}

/**
 * Intersects a child's requested tools with the parent's.
 *
 * OMP has no subset check anywhere — the trace found no parent/child tool
 * comparison in the whole source tree, and three ways a child routinely ends up
 * with *more* tools than its parent. Here a definition's `tools` is a ceiling:
 * anything not in the parent's active set is dropped, and an absent list means
 * "inherit the parent's set unchanged" rather than "everything".
 */
export function narrowToolNames(parent: readonly string[], requested: readonly string[] | undefined): string[] {
	if (!requested) return [...parent];
	const allowed = new Set(parent);
	// Preserve parent order so the child's declared order stays stable.
	return parent.filter((name) => requested.includes(name) && allowed.has(name));
}

/** A registered child. */
export interface AgentRef {
	/** Opaque, generated, never parsed. */
	id: string;
	/** Definition name. */
	name: string;
	/** Parent's id, or undefined for a root. */
	parentId?: string;
	/** Delegation depth. A root is 0. */
	depth: number;
	state: AgentState;
	/** Epoch ms of registration. */
	createdAt: number;
	/** Epoch ms of the last state change. */
	updatedAt: number;
	/** Present exactly once the state is terminal. */
	outcome?: AgentOutcome;
	/** The child's result text, once available. */
	result?: string;
	/** Tool names actually granted after narrowing. */
	tools: string[];
	/** The role the definition asked for, before any resolution. */
	requestedRole?: string;
	/** The model actually used, once resolved. */
	resolvedModel?: string;
	/**
	 * Whether this child's result has been handed to the parent.
	 *
	 * OMP has no such flag; it guards double-delivery with a `yieldCalled` latch
	 * that an async-result injection invalidates. A single boolean on the record is
	 * harder to get wrong, and the delivery path checks it.
	 */
	delivered: boolean;
}

/**
 * Tracks children and enforces lifecycle rules.
 *
 * Registration order matters: a child is registered before any model is resolved
 * or any tool is granted, so a parent that aborts mid-spawn still has a record of
 * everything it started and can cancel it. OMP registers inside
 * `createAgentSession` for the same reason.
 */
export class AgentRegistry {
	readonly #agents = new Map<string, AgentRef>();
	#counter = 0;
	readonly #now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Registers a child.
	 *
	 * The parent must already exist unless it is a root. A parent's child count is
	 * unbounded here — concurrency is a separate concern, bounded at spawn time —
	 * so a failure to spawn is still recorded and can be cleaned up.
	 */
	register(input: {
		name: string;
		parentId?: string;
		tools: readonly string[];
		requestedRole?: string;
		maxDepth?: number;
	}): AgentRef {
		const now = this.#now();
		const parent = input.parentId ? this.#agents.get(input.parentId) : undefined;
		const depth = parent ? parent.depth + 1 : 0;

		this.#counter += 1;
		// Opaque and monotonic. OMP's `bg_N` counter is never recycled, and the
		// same discipline applies here: a stale id must never name a new child.
		const id = `agent-${this.#counter}`;

		const ref: AgentRef = {
			id,
			name: input.name,
			parentId: input.parentId,
			depth,
			state: "queued",
			createdAt: now,
			updatedAt: now,
			tools: [...input.tools],
			requestedRole: input.requestedRole,
			delivered: false,
		};
		this.#agents.set(id, ref);
		return { ...ref, tools: [...ref.tools] };
	}

	/** A snapshot safe to hand to a caller. */
	get(id: string): AgentRef | undefined {
		const ref = this.#agents.get(id);
		return ref ? this.#snapshot(ref) : undefined;
	}

	/** All children of a parent, in registration order. */
	childrenOf(parentId: string): AgentRef[] {
		return [...this.#agents.values()].filter((ref) => ref.parentId === parentId).map((ref) => this.#snapshot(ref));
	}

	/** Every registered child, in registration order. */
	list(): AgentRef[] {
		return [...this.#agents.values()].map((ref) => this.#snapshot(ref));
	}

	/** Children that have not reached a terminal state. */
	active(): AgentRef[] {
		return this.list().filter((ref) => !isTerminalAgentState(ref.state));
	}

	/**
	 * Moves a child to `running`.
	 *
	 * Refuses a transition out of a terminal state, so a late start after a
	 * cancellation cannot resurrect a child that was already stopped.
	 */
	markRunning(id: string): boolean {
		return this.#transition(id, "running");
	}

	/** Records a terminal outcome. Returns false if the child was already terminal. */
	finish(id: string, outcome: AgentOutcome): boolean {
		const ref = this.#agents.get(id);
		if (!ref || isTerminalAgentState(ref.state)) return false;
		ref.state = outcome.state;
		ref.outcome = { ...outcome };
		ref.updatedAt = this.#now();
		return true;
	}

	/**
	 * Records a child's result text, once.
	 *
	 * Returns false when a result is already present, which is what makes
	 * "delivered exactly once" checkable rather than merely intended.
	 */
	setResult(id: string, result: string): boolean {
		const ref = this.#agents.get(id);
		if (!ref || ref.result !== undefined) return false;
		ref.result = result;
		ref.updatedAt = this.#now();
		return true;
	}

	/**
	 * Marks a result as handed to the parent.
	 *
	 * Returns false on a second call, so a duplicated delivery attempt is visible
	 * rather than silent.
	 */
	markDelivered(id: string): boolean {
		const ref = this.#agents.get(id);
		if (!ref || ref.delivered) return false;
		ref.delivered = true;
		ref.updatedAt = this.#now();
		return true;
	}

	/** Records the model a child actually used, for diagnostics. */
	setResolvedModel(id: string, model: string): void {
		const ref = this.#agents.get(id);
		if (!ref) return;
		ref.resolvedModel = model;
		ref.updatedAt = this.#now();
	}

	/**
	 * Cancels a child that has not finished.
	 *
	 * Returns the ids actually transitioned, so a parent can assert that nothing
	 * was left running. A child already terminal is untouched: cancelling completed
	 * work would rewrite history.
	 */
	cancel(id: string, reason: AgentOutcomeReason, message?: string): boolean {
		return this.finish(id, { state: "cancelled", reason, message, at: this.#now() });
	}

	/**
	 * Cancels every non-terminal descendant of an agent, depth first.
	 *
	 * This is what makes "no orphaned execution" enforceable. Returns the ids
	 * cancelled, deepest first, so a caller can await teardown in a safe order.
	 */
	cancelDescendants(rootId: string, reason: AgentOutcomeReason = "cancelled-by-parent"): string[] {
		const descendants = this.descendantsOf(rootId);
		// Deepest first, so a parent is never left running with a live child.
		descendants.sort((a, b) => b.depth - a.depth);
		const cancelled: string[] = [];
		for (const ref of descendants) {
			if (this.cancel(ref.id, reason)) cancelled.push(ref.id);
		}
		return cancelled;
	}

	/** Every descendant of an agent, excluding itself. */
	descendantsOf(rootId: string): AgentRef[] {
		const out: AgentRef[] = [];
		const walk = (parentId: string) => {
			for (const child of this.childrenOf(parentId)) {
				out.push(child);
				walk(child.id);
			}
		};
		walk(rootId);
		return out;
	}

	/** The deepest delegation chain in the registry. Zero when empty. */
	maxDepth(): number {
		return this.list().reduce((max, ref) => Math.max(max, ref.depth), 0);
	}

	/**
	 * Forgets a terminal child.
	 *
	 * Refuses a non-terminal child, so a registry cannot be emptied while work is
	 * still running.
	 */
	forget(id: string): boolean {
		const ref = this.#agents.get(id);
		if (!ref || !isTerminalAgentState(ref.state)) return false;
		return this.#agents.delete(id);
	}

	#transition(id: string, next: AgentState): boolean {
		const ref = this.#agents.get(id);
		if (!ref || isTerminalAgentState(ref.state)) return false;
		ref.state = next;
		ref.updatedAt = this.#now();
		return true;
	}

	#snapshot(ref: AgentRef): AgentRef {
		return {
			...ref,
			tools: [...ref.tools],
			...(ref.outcome ? { outcome: { ...ref.outcome } } : {}),
		};
	}
}

/** The root id used when a session has no parent agent. */
export const ROOT_AGENT_ID = "root";
