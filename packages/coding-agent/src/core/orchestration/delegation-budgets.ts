/**
 * Concurrency and delegation budgets.
 *
 * ## What OMP does, and what this corrects
 *
 * OMP's `Semaphore` is per-`TaskTool`-instance, which in production means
 * per-session — so a depth-2 tree can run 32 concurrent at *each* level at once.
 * The trace also found `workpool` and the eval `agent()` bridge spawning without
 * acquiring it at all, so a pool plus concurrent `task` calls reaches twice the
 * configured limit.
 *
 * Here the semaphore is shared per session and is the only path to a running
 * child: `TaskRunner` owns one, and every spawn acquires through it. There is no
 * second spawn route that could skip it.
 *
 * OMP also has no token or turn budget for a child — `TaskTool` never consults
 * `getTurnBudget`. A delegated run is bounded only by request count and wall
 * clock. This adds a request budget and makes exhaustion a typed terminal result
 * rather than a silent stop.
 */

/** Why a spawn was refused or a run was stopped. */
export type BudgetRefusal =
	| { kind: "depth"; limit: number; depth: number }
	| { kind: "concurrency"; limit: number }
	| { kind: "recursive-delegation"; depth: number };

/** Bounds applied to a delegation tree. */
export interface DelegationBudgets {
	/**
	 * Maximum number of children running at once, across the whole tree.
	 *
	 * `0` or negative means unbounded, matching OMP's `task.maxConcurrency` of 0.
	 */
	maxConcurrency: number;
	/**
	 * Maximum delegation depth. A root agent is depth 0, so a value of 1 allows a
	 * child but not a grandchild.
	 *
	 * Negative means unlimited. `0` forbids delegation entirely.
	 */
	maxDepth: number;
	/**
	 * Maximum LLM requests a single child may make.
	 *
	 * OMP has no equivalent for `task`; the trace found `getTurnBudget` is never
	 * consulted on the spawn path. Exhaustion is a typed terminal result, so a run
	 * that hits it ends rather than continuing.
	 */
	maxRequestsPerChild: number;
	/**
	 * Wall-clock limit for a single child, in milliseconds. `0` disables.
	 */
	maxRuntimeMs: number;
}

export const DEFAULT_DELEGATION_BUDGETS: DelegationBudgets = {
	// OMP's `task.maxConcurrency` default is 32; OMP's is per-session, this is
	// per-tree, so the effective ceiling is the same or stricter.
	maxConcurrency: 8,
	// OMP's `task.maxRecursionDepth` default is 2.
	maxDepth: 2,
	// No OMP equivalent.
	maxRequestsPerChild: 200,
	// OMP's `task.maxRuntimeMs` default is 0 (off). Kept off by default so a
	// delegated task is not cut off mid-flight by surprise; the request budget is
	// the default guard.
	maxRuntimeMs: 0,
};

/**
 * A counting semaphore with FIFO admission.
 *
 * A permit is released exactly once per successful acquire. `tryAcquire` is the
 * only non-blocking path, and a permit is never handed out twice — which is what
 * makes the limit a bound rather than a suggestion.
 */
export class DelegationSemaphore {
	#limit: number;
	#held = 0;
	readonly #waiters: (() => void)[] = [];

	constructor(limit: number) {
		this.#limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;
	}

	/** Permits currently held. */
	get held(): number {
		return this.#held;
	}

	/** True when another permit could be taken right now. */
	get available(): boolean {
		return this.#held < this.#limit;
	}

	/**
	 * Takes a permit, waiting if necessary.
	 *
	 * Resolves to a release function rather than exposing `release`, so a caller
	 * cannot release a permit it never acquired — the mistake that would let a
	 * later spawn start past the limit.
	 */
	async acquire(): Promise<() => void> {
		if (this.available) {
			this.#held += 1;
		} else {
			// Queued. A releasing holder transfers the slot *without* decrementing, so
			// the count never dips below the permits actually in flight. A waiter that
			// re-checked availability on wake could otherwise double-grant one free
			// slot to two waiters.
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
		let released = false;
		return () => {
			// Flipping the flag first makes a double-release inert rather than a
			// permit theft from a running child.
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			// Slot transferred: the count is deliberately unchanged.
			if (next) {
				next();
				return;
			}
			this.#held -= 1;
		};
	}

	/** Takes a permit only if one is free. Never queues. */
	tryAcquire(): (() => void) | undefined {
		if (!this.available) return undefined;
		this.#held += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// Same transfer rule as `acquire`, so a queued waiter cannot be
			// double-granted by whichever path released first.
			const next = this.#waiters.shift();
			if (next) {
				next();
				return;
			}
			this.#held -= 1;
		};
	}
}

/** Additive per-child accounting. */
export class RequestBudget {
	#used = 0;
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;
	}

	get used(): number {
		return this.#used;
	}

	get limit(): number {
		return this.#limit;
	}

	get exhausted(): boolean {
		return this.#used >= this.#limit;
	}

	/** Records one request. Returns false when the budget is already spent. */
	consume(): boolean {
		if (this.exhausted) return false;
		this.#used += 1;
		return true;
	}
}

/**
 * Decides whether a spawn is admissible.
 *
 * Pure, so the answer is testable without a running tree. Every refusal is typed:
 * a caller can distinguish "too deep" from "too many running" without parsing a
 * message, which is what turns a bound into a terminal result rather than a hang.
 */
export function evaluateSpawn(input: {
	/** Depth the child would occupy. A root is 0. */
	childDepth: number;
	/** Children already running, tree-wide. */
	running: number;
	budgets: DelegationBudgets;
	/** Whether the definition permits spawning at all. */
	spawnsAllowed?: boolean;
}): BudgetRefusal | undefined {
	if (input.spawnsAllowed === false) {
		return { kind: "recursive-delegation", depth: input.childDepth };
	}
	if (input.budgets.maxDepth >= 0 && input.childDepth > input.budgets.maxDepth) {
		return { kind: "depth", limit: input.budgets.maxDepth, depth: input.childDepth };
	}
	if (input.budgets.maxConcurrency > 0 && input.running >= input.budgets.maxConcurrency) {
		return { kind: "concurrency", limit: input.budgets.maxConcurrency };
	}
	return undefined;
}

/** A human-readable explanation of a refusal, for a terminal result. */
export function describeRefusal(refusal: BudgetRefusal): string {
	switch (refusal.kind) {
		case "depth":
			return `Cannot delegate past depth ${refusal.limit}; this spawn would be at depth ${refusal.depth}.`;
		case "concurrency":
			return `Cannot start another agent: ${refusal.limit} are already running. Wait for one to finish.`;
		case "recursive-delegation":
			return `This agent is not permitted to delegate, so it cannot spawn a child.`;
	}
}
