/**
 * Delegation: spawning a child agent under Pi's authorities.
 *
 * ## The one property everything else serves
 *
 * **Delegation must not become a way around Phase 3.**
 *
 * OMP fails this. `createSubagentSettings` hard-overrides the child's approval
 * mode to `yolo` (`executor.ts:1072-1077`), and the trace found a parent with a
 * narrowed tool list still handing its child the *full* default set, because
 * `restrictToolNames` only propagates through plan mode. A child in OMP can
 * therefore run tools its parent could not.
 *
 * Here a child is not a session. It is a *runner* that takes the parent's gate
 * explicitly and a tool list already narrowed by `narrowToolNames`. There is no
 * path that constructs a child without passing through both.
 *
 * ## Model selection is a proposal, never a grant
 *
 * The chain is the one every role uses: a requested role goes to
 * `resolveRoleChain`, whose candidates are filtered by the eligibility input, and
 * `selectFailoverCandidate` remains the final authority. A child asking for a role
 * that prefers a paid model gets nothing under a free-only session, exactly as
 * the parent would.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { redactMessages } from "../security/secret-transform.ts";
import type { SecretRedactor } from "../security/secrets.ts";
import {
	type AgentOutcomeReason,
	type AgentRef,
	AgentRegistry,
	type AgentState,
	narrowToolNames,
	ROOT_AGENT_ID,
} from "./agent-registry.ts";
import {
	DEFAULT_DELEGATION_BUDGETS,
	type DelegationBudgets,
	DelegationSemaphore,
	describeRefusal,
	evaluateSpawn,
	RequestBudget,
} from "./delegation-budgets.ts";

/** What a caller supplies to run a child. */
export interface TaskRunRequest {
	/** Definition name, for diagnostics and policy. */
	agent: string;
	/** The assignment handed to the child. */
	task: string;
	/** Extra context the parent chose to share. Never the parent's transcript. */
	context?: string;
	/** Tool names this child requests. Narrowed against the parent. */
	tools?: readonly string[];
	/** Model role this child prefers. A proposal. */
	modelRole?: string;
	/** Wall-clock override for this child only. */
	maxRuntimeMs?: number;
}

/**
 * The gate a child inherits.
 *
 * Required, not optional. That is the structural difference from OMP, where a
 * child's approval mode is whatever an overlay says and omission is possible.
 */
export interface ChildGate {
	/**
	 * The parent's approval decision, applied on the child's behalf.
	 *
	 * The runner executes nothing itself. Every tool the child wants goes through
	 * this function, which is the same one the parent's own calls use — so a child
	 * cannot bypass approval, and the planning barrier applies to a delegated
	 * write exactly as it does to a direct one.
	 */
	beforeToolCall: (input: {
		toolName: string;
		args: unknown;
	}) => Promise<{ block?: boolean; reason?: string } | undefined>;
	/** Tool names the parent currently has active. The ceiling for any child. */
	parentTools: readonly string[];
}

/** Machine-readable cause of a non-completion. */
export type TaskFailureCode =
	| "depth-limit"
	| "concurrency-limit"
	| "cancelled"
	| "runtime-limit"
	| "request-budget"
	| "child-error"
	| "denied-by-gate"
	| "spawns-not-allowed";

/** The outcome of one delegation attempt. */
export type TaskRunResult =
	| { ok: true; id: string; state: Extract<AgentState, "completed">; result: string; model?: string }
	| { ok: false; id?: string; state: AgentState; reason: string; code: TaskFailureCode };

export interface TaskRunnerOptions {
	registry?: AgentRegistry;
	budgets?: DelegationBudgets;
	/** Default gate for children. Required: omission would be a bypass. */
	gate: ChildGate;
	/** Resolves a child's model. Must apply Pi's eligibility authorities. */
	resolveModel: (input: { role: string | undefined; sessionModel: Model<Api> | undefined }) => Promise<{
		model?: Model<Api>;
		rejectedReason?: string;
	}>;
	/** The parent's live model, used for inheritance and free-only gating. */
	getSessionModel: () => Model<Api> | undefined;
	/** Redactor applied to a child's provider-bound context. */
	redactor?: SecretRedactor;
	/**
	 * Runs the child. Supplied by the host, because constructing a child means
	 * constructing an Agent, which needs a stream function and a tool set.
	 */
	run: (input: {
		id: string;
		definition: TaskRunRequest;
		tools: readonly string[];
		model?: Model<Api>;
		signal: AbortSignal;
		budget: RequestBudget;
		/** Redact before anything becomes provider-bound. */
		redact: (messages: unknown[]) => unknown[];
		gate: ChildGate;
	}) => Promise<string>;
	/** Called after a child settles, for delivery. */
	onComplete?: (id: string, result: string) => void;
}

/** Abort reason used only for a runtime timeout, so the two stops are distinguishable. */
const RUNTIME_TIMEOUT = "runtime-limit";

/**
 * Runs delegated children under bounded concurrency and a shared gate.
 *
 * One instance per session. The semaphore is per-runner, so the limit is
 * tree-wide rather than per-tool-instance, and every spawn in the session goes
 * through it — OMP has two spawn routes that skip its semaphore entirely.
 */
export class TaskRunner {
	readonly registry: AgentRegistry;
	readonly #budgets: DelegationBudgets;
	readonly #semaphore: DelegationSemaphore;
	readonly #options: TaskRunnerOptions;
	/** Abort controllers by child id, so cancellation reaches a running child. */
	readonly #running = new Map<string, AbortController>();
	#cancelled = false;

	constructor(options: TaskRunnerOptions) {
		this.#options = options;
		this.registry = options.registry ?? new AgentRegistry();
		this.#budgets = options.budgets ?? DEFAULT_DELEGATION_BUDGETS;
		this.#semaphore = new DelegationSemaphore(this.#budgets.maxConcurrency);
	}

	/** Children currently executing, tree-wide. */
	get runningCount(): number {
		return this.#running.size;
	}

	/** The parent agent id used for root-level children. */
	get parentId(): string {
		return ROOT_AGENT_ID;
	}

	/**
	 * Runs one child.
	 *
	 * Admission is checked before anything is registered, so a refused spawn
	 * leaves no record and no permit. A refusal is a typed result rather than an
	 * exception, so a caller that ignores delegation still gets a usable turn.
	 */
	async run(request: TaskRunRequest): Promise<TaskRunResult> {
		const parent = this.registry.get(this.parentId);
		const childDepth = parent ? parent.depth + 1 : 1;

		const refusal = evaluateSpawn({ childDepth, running: this.#running.size, budgets: this.#budgets });
		if (refusal) {
			return {
				ok: false,
				state: "rejected",
				reason: describeRefusal(refusal),
				code:
					refusal.kind === "depth"
						? "depth-limit"
						: refusal.kind === "concurrency"
							? "concurrency-limit"
							: "spawns-not-allowed",
			};
		}

		// A child may only ever narrow the parent's tools. Computed before
		// registration so the record shows what was actually granted.
		const granted = narrowToolNames(this.#options.gate.parentTools, request.tools);
		const ref = this.registry.register({
			name: request.agent,
			parentId: this.parentId,
			tools: granted,
			requestedRole: request.modelRole,
		});

		// A permit is held for the whole run and released exactly once, including
		// on every failure path below.
		const release = await this.#semaphore.acquire();

		if (this.#cancelled) {
			release();
			this.registry.cancel(ref.id, "cancelled-by-parent", "Session was cancelled before the child started.");
			return { ok: false, id: ref.id, state: "cancelled", reason: "Session was cancelled.", code: "cancelled" };
		}

		const controller = new AbortController();
		this.#running.set(ref.id, controller);
		this.registry.markRunning(ref.id);

		// A falsy delay would fire `setTimeout` immediately, so the limit is
		// normalized here rather than guarded at the call site.
		const runtimeLimit = request.maxRuntimeMs ?? this.#budgets.maxRuntimeMs;
		const timer = runtimeLimit > 0 ? setTimeout(() => controller.abort(RUNTIME_TIMEOUT), runtimeLimit) : undefined;

		try {
			// Model resolution goes through the same chain every role uses, so a
			// child's request cannot outrank the parent's policy.
			const resolution = await this.#options.resolveModel({
				role: request.modelRole,
				sessionModel: this.#options.getSessionModel(),
			});
			if (resolution.model) this.registry.setResolvedModel(ref.id, resolution.model.id);

			const result = await this.#options.run({
				id: ref.id,
				definition: request,
				tools: granted,
				model: resolution.model,
				signal: controller.signal,
				budget: new RequestBudget(this.#budgets.maxRequestsPerChild),
				redact: (messages) =>
					this.#options.redactor ? redactMessages(messages as never, this.#options.redactor) : messages,
				gate: this.#options.gate,
			});

			if (controller.signal.aborted) {
				// A timeout and a cancellation both abort the signal; the abort reason
				// is what tells them apart, so the parent is not misinformed.
				const timedOut = controller.signal.reason === RUNTIME_TIMEOUT;
				const reason = timedOut ? "Child exceeded its runtime limit." : "Child was cancelled.";
				this.registry.finish(ref.id, {
					state: timedOut ? "timed-out" : "cancelled",
					reason: timedOut ? "runtime-limit" : "cancelled-by-parent",
					message: reason,
					at: Date.now(),
				});
				return {
					ok: false,
					id: ref.id,
					state: timedOut ? "timed-out" : "cancelled",
					reason,
					code: timedOut ? "runtime-limit" : "cancelled",
				};
			}

			// A result is recorded once and marked delivered once, so a duplicated
			// completion is observable rather than silently overwriting.
			this.registry.setResult(ref.id, result);
			this.registry.finish(ref.id, { state: "completed", reason: "completed", at: Date.now() });
			this.registry.markDelivered(ref.id);
			this.#options.onComplete?.(ref.id, result);
			return {
				ok: true,
				id: ref.id,
				state: "completed",
				result,
				...(resolution.model ? { model: resolution.model.id } : {}),
			};
		} catch (error) {
			// A cooperative child rethrows when its signal aborts, so the abort is
			// checked first. Without this a timeout would be reported as an ordinary
			// failure, and the parent would be told the wrong thing about why the
			// work stopped.
			if (controller.signal.aborted) {
				const timedOut = controller.signal.reason === RUNTIME_TIMEOUT;
				const reason = timedOut ? "Child exceeded its runtime limit." : "Child was cancelled.";
				this.registry.finish(ref.id, {
					state: timedOut ? "timed-out" : "cancelled",
					reason: timedOut ? "runtime-limit" : "cancelled-by-parent",
					message: reason,
					at: Date.now(),
				});
				return {
					ok: false,
					id: ref.id,
					state: timedOut ? "timed-out" : "cancelled",
					reason,
					code: timedOut ? "runtime-limit" : "cancelled",
				};
			}
			// A failing child produces a terminal result. The parent is never left
			// waiting, which is the property OMP gets only from a catch at its own
			// boundary.
			const message = error instanceof Error ? error.message : String(error);
			this.registry.finish(ref.id, { state: "failed", reason: "child-error", message, at: Date.now() });
			return { ok: false, id: ref.id, state: "failed", reason: message, code: "child-error" };
		} finally {
			clearTimeout(timer);
			this.#running.delete(ref.id);
			release();
		}
	}

	/**
	 * Runs several children, bounded by the shared semaphore.
	 *
	 * Every item is attempted: one child failing does not cancel its siblings,
	 * because a batch where one task fails is still a batch worth completing.
	 */
	async runAll(requests: readonly TaskRunRequest[]): Promise<TaskRunResult[]> {
		return Promise.all(requests.map((request) => this.run(request)));
	}

	/**
	 * Cancels a running child.
	 *
	 * Returns false when the child is unknown or already terminal, so a caller
	 * can assert that cancellation actually took effect.
	 */
	cancel(id: string, reason: AgentOutcomeReason = "cancelled-by-caller"): boolean {
		this.#running.get(id)?.abort();
		return this.registry.cancel(id, reason);
	}

	/**
	 * Cancels every running child and refuses further spawns.
	 *
	 * After this, `run` returns a cancellation for anything new. That is what
	 * guarantees a parent cancellation leaves nothing running: a late-arriving
	 * spawn cannot start, and an in-flight one is aborted.
	 */
	cancelAll(reason: AgentOutcomeReason = "cancelled-by-parent"): string[] {
		this.#cancelled = true;
		const ids: string[] = [];
		for (const [id, controller] of this.#running) {
			controller.abort();
			if (this.registry.cancel(id, reason)) ids.push(id);
		}
		return ids;
	}

	/** Re-enables spawning after `cancelAll`. */
	resume(): void {
		this.#cancelled = false;
	}

	/** A snapshot of every registered child. */
	list(): AgentRef[] {
		return this.registry.list();
	}
}
