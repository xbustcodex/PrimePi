/**
 * Plan mode state.
 *
 * ## What this is, traced from OMP
 *
 * OMP does **not** model this as an enum. `plan-mode/state.ts:1-6` declares
 * `PlanModeState { enabled, planFilePath, workflow?, reentry? }` — four fields, no
 * status. The real state machine is the triple of two booleans on
 * `InteractiveMode` (`planModeEnabled`, `planModePaused`, `interactive-mode.ts:981-982`),
 * an optional `PlanModeState` on the session, and a journaled `mode_change` with
 * values `"plan" | "plan_paused" | "none"`.
 *
 * Critically, OMP has **no "plan approved" state at all**
 * (`PlanModeStateMachine` trace §2). Approval lives outside the machine in
 * `AgentSession.#planReferencePath` / `#planReferenceSent`
 * (`agent-session.ts:739-740`), and teardown never touches those fields. That is
 * exactly why disabling plan mode after approval does not discard the plan.
 *
 * This module ports that shape, and makes the one thing OMP leaves implicit
 * explicit: `PlanPhase` is a real union, so "approved plan guiding
 * implementation" is a state a caller can read rather than infer from the
 * absence of `enabled`. The user requirement is precisely that these be
 * distinguishable, and an inference from two booleans is what makes OMP's UI able
 * to say "Plan Mode is active" while an approved plan is still attached.
 */

/** Where a plan is in its lifecycle. */
export type PlanPhase =
	/** No plan exists and none is being drafted. */
	| "inactive"
	/** The agent is drafting a plan. Writes to the working tree are refused. */
	| "planning"
	/**
	 * A plan has been drafted and submitted, and the operator has not yet
	 * responded. Refinement is still possible; approval has not happened.
	 */
	| "reviewing"
	/**
	 * A plan was approved and remains attached as guidance.
	 *
	 * This is distinct from `inactive` and from `planning`: plan mode is off, the
	 * write barrier is lifted, and the plan is still available to the model. It is
	 * the state OMP cannot represent, and the one that must not be conflated with
	 * either neighbour.
	 */
	| "approved"
	/**
	 * A plan exists but is explicitly withdrawn, superseded, or cleared.
	 *
	 * Distinct from `inactive` so a caller can tell "never had a plan" from
	 * "had one and it was replaced". The draft is retained on disk either way;
	 * only the authority is withdrawn.
	 */
	| "superseded";

/** How a plan was ended, for diagnostics and for the state after a transition. */
export type PlanEndReason =
	/** The operator toggled plan mode off with no plan attached. */
	| "mode-disabled"
	/** The operator toggled plan mode off while a plan was attached. */
	| "mode-disabled-with-plan"
	/** The operator rejected the plan and asked for refinement. */
	| "rejected"
	/** The operator rejected and discarded it. */
	| "rejected-and-cleared"
	/** A newer plan replaced this one. */
	| "superseded"
	/** The operator explicitly cleared it. */
	| "cleared";

/** A plan that exists, with the content that makes it usable as guidance. */
export interface PlanRecord {
	/** Stable identifier, unique within a session. */
	id: string;
	/** Human-facing title. */
	title: string;
	/**
	 * The plan body, verbatim.
	 *
	 * Held in state rather than only on disk so the guidance can be re-injected
	 * after a compaction without re-reading a file that may have moved. This is
	 * the difference from OMP, where the body lives at `local://<slug>-plan.md`
	 * and the journal records only the path — a gap the OMP trace flagged: after
	 * approval the journal's last `mode_change` is `"none"` with no data, so a
	 * fresh process cannot recover the plan's slug
	 * (`PlanRoleAndPersistence` trace §B3).
	 */
	content: string;
	/** Epoch ms when the plan was approved. Absent while unapproved. */
	approvedAt?: number;
	/** Epoch ms when the plan was created or replaced. */
	createdAt: number;
}

/**
 * The full orchestration state.
 *
 * One object rather than several fields, because the states are mutually
 * exclusive and representing them separately is what lets them drift.
 */
export interface PlanState {
	phase: PlanPhase;
	/**
	 * The plan currently attached, if any.
	 *
	 * Present in `planning`, `reviewing`, and `approved`. Also retained in
	 * `superseded` so the UI can show what was replaced — but never consulted for
	 * authority there.
	 */
	plan?: PlanRecord;
	/**
	 * True when a plan was drafted but never approved.
	 *
	 * Set when leaving `planning` with a draft and no approval. It is the flag
	 * that keeps an unapproved draft from being mistaken for implementation
	 * authority, which is the regression this phase must not reintroduce.
	 */
	unapproved: boolean;
	/** Why the previous phase ended. Cleared by `beginPlanning`. */
	lastEnd?: { reason: PlanEndReason; at: number };
}

export const INITIAL_PLAN_STATE: PlanState = { phase: "inactive", unapproved: false };

/** Deep-enough copy: the only nested mutable value is a flat plan record. */
function clonePlan(plan: PlanRecord): PlanRecord {
	return { ...plan };
}

function cloneState(state: PlanState): PlanState {
	return {
		...state,
		plan: state.plan ? clonePlan(state.plan) : undefined,
		lastEnd: state.lastEnd ? { ...state.lastEnd } : undefined,
	};
}

/**
 * Whether the working tree must be read-only right now.
 *
 * A single predicate so the write barrier has exactly one definition. True only
 * while drafting; approval lifts it, which is the whole point of approving.
 */
export function isWriteBarrierActive(state: PlanState): boolean {
	return state.phase === "planning" || state.phase === "reviewing";
}

/**
 * Whether a plan is available to guide implementation.
 *
 * True only in `approved`. An unapproved draft is explicitly not guidance: that is
 * the distinction the regression test pins.
 */
export function hasApprovedPlan(state: PlanState): boolean {
	return state.phase === "approved" && state.plan?.approvedAt !== undefined;
}

/** Whether a plan draft exists but was never approved. */
export function hasUnapprovedDraft(state: PlanState): boolean {
	return state.unapproved && state.plan !== undefined;
}

let idCounter = 0;

/** A session-scoped plan id. Not a UUID: it is only ever compared within a session. */
function nextPlanId(): string {
	idCounter += 1;
	return `plan-${idCounter}`;
}

/** Test seam so ids are deterministic across runs. */
export function resetPlanIdCounter(): void {
	idCounter = 0;
}

/**
 * Enters planning.
 *
 * Any previously attached plan is superseded rather than reused: entering plan
 * mode means the user wants a new plan, and silently continuing to guide from the
 * old one would make a new plan's approval ambiguous.
 */
export function beginPlanning(state: PlanState, now: number): PlanState {
	const superseded = state.plan && state.phase === "approved" ? { reason: "superseded" as const, at: now } : undefined;
	return {
		phase: "planning",
		// A fresh draft slot, so a new plan cannot inherit the previous plan's
		// approval timestamp.
		plan: undefined,
		unapproved: false,
		lastEnd: superseded ?? state.lastEnd,
	};
}

/**
 * Records a draft the agent produced.
 *
 * Does not approve it. The draft is unapproved by construction, and `unapproved`
 * is set so any later exit cannot mistake it for guidance.
 */
export function recordDraft(
	state: PlanState,
	input: { id?: string; title: string; content: string; now: number },
): PlanState {
	return {
		...state,
		phase: "reviewing",
		plan: {
			id: input.id ?? nextPlanId(),
			title: input.title,
			content: input.content,
			createdAt: input.now,
		},
		unapproved: true,
	};
}

/**
 * Approves a plan.
 *
 * This is the transition that lifts the write barrier while *keeping* the plan as
 * guidance — the state OMP cannot represent and the reason this phase exists.
 */
export function approvePlan(state: PlanState, now: number): PlanState {
	if (!state.plan) return state;
	// Only a plan currently under review can be approved. Without this guard a
	// late approval could resurrect a rejected or superseded plan, turning a
	// withdrawn document into implementation authority after the fact.
	if (state.phase !== "reviewing" && state.phase !== "planning") return state;
	return {
		...state,
		phase: "approved",
		plan: { ...state.plan, approvedAt: now },
		unapproved: false,
	};
}

/**
 * Rejects a plan, optionally keeping the draft for refinement.
 *
 * `keepDraft: true` returns to `planning` so the agent can revise in place; the
 * write barrier stays up, which is correct because the plan was not accepted.
 */
export function rejectPlan(state: PlanState, options: { now: number; keepDraft?: boolean }): PlanState {
	if (!state.plan) return state;
	if (options.keepDraft) {
		return { ...state, phase: "planning", unapproved: true };
	}
	return {
		...state,
		phase: "superseded",
		unapproved: false,
		lastEnd: { reason: "rejected-and-cleared", at: options.now },
	};
}

/**
 * Leaves plan mode without touching the attached plan.
 *
 * The property this phase turns on: an approved plan survives a mode toggle. A
 * draft that was never approved does not become authority — it is retained and
 * flagged `unapproved`, but `hasApprovedPlan` stays false.
 */
export function leavePlanning(state: PlanState, now: number): PlanState {
	if (state.phase === "approved") {
		// Already approved: leaving changes nothing about authority.
		return cloneState(state);
	}
	if (state.plan) {
		// A draft exists and was never approved. Retain it, flag it, and stop
		// treating it as guidance.
		return {
			...cloneState(state),
			phase: "superseded",
			unapproved: true,
			lastEnd: { reason: "mode-disabled-with-plan", at: now },
		};
	}
	return { ...cloneState(state), phase: "inactive", unapproved: false, lastEnd: { reason: "mode-disabled", at: now } };
}

/**
 * Replaces the attached plan with a new one.
 *
 * The explicit supersede operation. Destruction is never coupled to a mode
 * toggle — it is always a deliberate call.
 */
export function supersedePlan(state: PlanState, now: number): PlanState {
	if (!state.plan) return { ...cloneState(state), phase: "inactive", unapproved: false };
	return { ...cloneState(state), phase: "superseded", unapproved: false, lastEnd: { reason: "superseded", at: now } };
}

/**
 * Clears the attached plan entirely.
 *
 * The explicit clear operation. After this there is no plan of any status, which
 * is distinguishable from `superseded`, where the previous plan is still recorded
 * for display.
 */
export function clearPlan(_state: PlanState, now: number): PlanState {
	return {
		phase: "inactive",
		plan: undefined,
		unapproved: false,
		lastEnd: { reason: "cleared", at: now },
	};
}

/**
 * Rebuilds state from a persisted record.
 *
 * Unknown or absent data yields `inactive` rather than throwing, so an older
 * session file cannot break a resume.
 */
export function planStateFromRecord(record: unknown): PlanState {
	if (!record || typeof record !== "object") return { ...INITIAL_PLAN_STATE };
	const candidate = record as Partial<PlanState>;
	if (typeof candidate.phase !== "string") return { ...INITIAL_PLAN_STATE };

	const phases: readonly PlanPhase[] = ["inactive", "planning", "reviewing", "approved", "superseded"];
	if (!phases.includes(candidate.phase as PlanPhase)) return { ...INITIAL_PLAN_STATE };

	const plan =
		candidate.plan && typeof candidate.plan === "object"
			? {
					id: typeof candidate.plan.id === "string" ? candidate.plan.id : "plan-restored",
					title: typeof candidate.plan.title === "string" ? candidate.plan.title : "Restored plan",
					content: typeof candidate.plan.content === "string" ? candidate.plan.content : "",
					createdAt: typeof candidate.plan.createdAt === "number" ? candidate.plan.createdAt : 0,
					...(typeof candidate.plan.approvedAt === "number" ? { approvedAt: candidate.plan.approvedAt } : {}),
				}
			: undefined;

	return {
		phase: candidate.phase as PlanPhase,
		plan,
		// An `approved` phase without an approval timestamp is downgraded rather
		// than trusted, so a hand-edited or truncated journal cannot manufacture
		// implementation authority.
		unapproved:
			candidate.phase === "approved" && plan?.approvedAt === undefined ? true : candidate.unapproved === true,
	};
}

/** A copy safe to hand to a caller or serialize. */
export function snapshotPlanState(state: PlanState): PlanState {
	return cloneState(state);
}
