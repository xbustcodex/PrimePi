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
	DEFAULT_ISOLATION,
	decideIntegration,
	type IsolationDecision,
	type IsolationSettings,
} from "../task/isolation.ts";
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
import type { WorktreeHandle, WorktreeManager } from "./worktree-manager.js";

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
	/**
	 * Run without awaiting completion.
	 *
	 * The tool returns a job id either way; this records which of the two paths
	 * the caller is on, so a record recovered after a restart can tell a
	 * background child from a foreground one.
	 */
	background?: boolean;
	/**
	 * The background job this child is running under, when there is one.
	 *
	 * Carried so the job can name the child that ran it. The association has to be
	 * made at registration rather than at completion: a child that dies with the
	 * process never completes, and a crash report that cannot name the child is a
	 * report about nothing.
	 */
	jobId?: string;
	/**
	 * Whether the child gets its own worktree.
	 *
	 * Opt-in per call: `shared` for a read-only research child, `worktree`
	 * for a coding child whose changes must not land inline. A child that asks
	 * for a worktree never has one merged back automatically — the workspace is
	 * reported so the operator can inspect or merge it deliberately.
	 */
	isolation?: "shared" | "worktree";
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
	/**
	 * Tool names the parent currently has active. The ceiling for any child.
	 *
	 * A getter rather than a value: the session constructs the runner while its
	 * tool registry is still being assembled, so a value captured then would be
	 * empty and every child would be granted nothing. Reading at spawn time is
	 * also the correct semantics — the ceiling is what the parent holds now.
	 */
	readonly parentTools: readonly string[];
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
	/** Workspace provisioning, for a child that asked for its own worktree. */
	worktrees?: WorktreeManager;
	/**
	 * Reads a settings value by key. Supplied by the host so the isolation policy
	 * follows the user's configuration; absent, the documented defaults apply.
	 */
	readSetting?: (key: string) => unknown;
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
		/** The workspace the child was given, when it asked for one. */
		workspace?: WorktreeHandle;
		/** Redact before anything becomes provider-bound. */
		redact: (messages: unknown[]) => unknown[];
		gate: ChildGate;
	}) => Promise<string>;
	/** Called after a child settles, for delivery. */
	onComplete?: (id: string, result: string) => void;
	/**
	 * Called the moment a child is registered, before it runs.
	 *
	 * The earliest point at which a child has an id, and therefore the only one at
	 * which a crash can still be attributed to it.
	 */
	onSpawn?: (input: { childId: string; jobId: string | undefined }) => void;
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
/**
 * Reads the isolation policy from a settings reader.
 *
 * Each field falls back independently, so a user who sets only `apply` gets the
 * documented defaults for the rest rather than a whole default policy that
 * silently discards their one deliberate choice.
 *
 * `apply` defaults to **false**, a deliberate divergence from OMP's true. An
 * automatic merge can collide with work the user has done since the child
 * started; returning a reference is safe where merging is not. The decision is
 * still computed and recorded either way, so enabling it is a setting change
 * rather than a code change.
 */
function resolveIsolationSettings(read: ((key: string) => unknown) | undefined): IsolationSettings {
	const enabled = read?.("task.isolation.enabled");
	const merge = read?.("task.isolation.merge");
	const commits = read?.("task.isolation.commits");
	const apply = read?.("task.isolation.apply");
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_ISOLATION.enabled,
		merge: merge === "branch" || merge === "patch" ? merge : DEFAULT_ISOLATION.merge,
		commits: commits === "ai" || commits === "generic" ? commits : DEFAULT_ISOLATION.commits,
		apply: typeof apply === "boolean" ? apply : DEFAULT_ISOLATION.apply,
		clone: DEFAULT_ISOLATION.clone,
		cleanSource: DEFAULT_ISOLATION.cleanSource,
	};
}

export class TaskRunner {
	readonly registry: AgentRegistry;
	readonly #budgets: DelegationBudgets;
	readonly #semaphore: DelegationSemaphore;
	readonly #options: TaskRunnerOptions;
	/** Abort controllers by child id, so cancellation reaches a running child. */
	readonly #running = new Map<string, AbortController>();
	/**
	 * The integration decision per task id.
	 *
	 * Recorded before the workspace is released, so the outcome stays readable
	 * after the workspace itself is gone. Exposed through `integrationFor` because
	 * the alternative is a log line nobody correlates with a task.
	 */
	readonly #integration = new Map<string, IsolationDecision>();
	#cancelled = false;

	/**
	 * What was decided for a finished task's isolated changes.
	 *
	 * Undefined for a task that never had a workspace, or one that has not finished
	 * yet. A caller that wants the workspace kept must consult this before it is
	 * released; a `discard` has already removed it by the time this returns.
	 */
	integrationFor(taskId: string): IsolationDecision | undefined {
		return this.#integration.get(taskId);
	}

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

		// The gate decides admission, not just individual tool calls. A child is
		// something the parent asked for on the model's behalf, so the same
		// authority that decides a parent's own call also decides whether the
		// child runs at all — which is what makes delegation incapable of being a
		// route around approval or the planning barrier.
		//
		// Checked before registration, so a denied spawn leaves no record and no
		// permit, exactly like a budget refusal above.
		const admission = await this.#options.gate.beforeToolCall({
			toolName: "task",
			args: { agent: request.agent, task: request.task, isolated: request.isolation === "worktree" },
		});
		if (admission?.block) {
			return {
				ok: false,
				state: "rejected",
				reason: admission.reason ?? "The approval policy refused to delegate this task.",
				code: "spawns-not-allowed",
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

		// Announced here rather than after the run, because a child that never
		// returns is exactly the child a restart has to be able to name.
		this.#options.onSpawn?.({ childId: ref.id, jobId: request.jobId });

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
		// Provisioned before the child runs and released on every exit path below, so
		// a failure or a cancellation cannot leak a workspace.
		let workspace: WorktreeHandle | undefined;
		// Set once the child produced a result; read by the integration decision in the
		// finally below, so it is declared alongside the workspace handle.
		let taskSucceeded = false;
		if (request.isolation === "worktree") {
			const refused = (detail: string) => {
				release();
				this.registry.finish(ref.id, {
					state: "failed",
					reason: "preflight-rejected",
					message: detail,
					at: Date.now(),
				});
				return {
					ok: false,
					id: ref.id,
					state: "failed",
					reason: detail,
					code: "spawns-not-allowed",
				} as const;
			};
			if (!this.#options.worktrees) {
				return refused("Isolation was requested but no workspace manager is configured.");
			}
			const outcome = await this.#options.worktrees.ensure(ref.id, "worktree");
			// A refusal to provision is a refusal to spawn, not a silent fallback.
			if (!outcome.ok) return refused(outcome.refusal.detail);
			workspace = outcome.handle;
		}

		try {
			// Model resolution goes through the same chain every role uses, so a
			// child's request cannot outrank the parent's policy.
			const resolution = await this.#options.resolveModel({
				role: request.modelRole,
				sessionModel: this.#options.getSessionModel(),
			});
			// A host that refused every eligible model must not be second-guessed.
			// Falling through to a run with no model would either fail opaquely
			// deeper in, or — worse — a host that silently substituted a paid model
			// would spend money the policy declined to spend. A rejection ends the
			// spawn, carrying the reason the model needs in order to try something
			// else.
			if (!resolution.model) {
				controller.abort();
				this.registry.finish(ref.id, {
					state: "failed",
					reason: "preflight-rejected",
					message: resolution.rejectedReason ?? "No model satisfied the child's eligibility rules.",
					at: Date.now(),
				});
				return {
					ok: false,
					id: ref.id,
					state: "failed",
					reason: resolution.rejectedReason ?? "No model satisfied the child's eligibility rules.",
					code: "spawns-not-allowed",
				};
			}
			this.registry.setResolvedModel(ref.id, resolution.model.id);

			const result = await this.#options.run({
				id: ref.id,
				definition: request,
				tools: granted,
				...(workspace ? { workspace } : {}),
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
			taskSucceeded = true;
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
			if (workspace && this.#options.worktrees) {
				// The decision is computed before the release, because releasing first
				// would destroy the work the decision is about. A discard removes the
				// workspace; a merge or a required approval keeps it, so the result
				// stays reachable.
				const decision = decideIntegration(resolveIsolationSettings(this.#options.readSetting), {
					taskSucceeded: taskSucceeded === true,
				});
				this.#integration.set(ref.id, decision);
				if (decision.action === "discard") this.#options.worktrees.release(ref.id);
			}
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
