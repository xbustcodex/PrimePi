/**
 * Plan-mode model transitions.
 *
 * ## What OMP does, traced
 *
 * `plan-mode/model-transition.ts:40-50` is a pure function from
 * `(currentModel, resolvedPlanRole, isStreaming)` to one of three variants:
 *
 *   - `{kind:"none"}` when the role resolves to nothing;
 *   - `{kind:"thinking"; thinkingLevel}` when the resolved model equals the
 *     current one and a level applies;
 *   - `{kind:"apply"; model; thinkingLevel; deferred}` otherwise, where `deferred`
 *     is `isStreaming` verbatim.
 *
 * Two properties worth keeping. An **unconfigured** `plan` role yields `none`, so
 * the default out of the box is to keep the user's own model rather than switch to
 * some built-in architect. And an **implicit** thinking level never overrides:
 * `planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined`.
 *
 * ## What is different here, and why
 *
 * OMP's `plan` resolution path is weaker than its normal role path: the trace
 * found it calls `resolveModelRoleValue` without `resolveRoleChain`, so there are
 * no retry candidates, and it discards `resolved.warning` at both call sites.
 *
 * This port resolves through `resolveRoleChain` — the same path every other role
 * uses — so the free-only, credential, cooldown, and provider-exclusion gates all
 * apply. A role that cannot produce a usable candidate yields no model, and the
 * session keeps the model it had.
 */

import type { Api, Model, RoleChainCandidate, RoleEligibility } from "@earendil-works/pi-ai";

/** What entering or leaving plan mode should do to the model. */
export type PlanModelTransition =
	/** Leave the model alone. The role resolved to nothing usable, or the model already matches. */
	| { kind: "none"; reason: string }
	/** Same model, different thinking level. */
	| { kind: "thinking"; thinkingLevel: string; reason: string }
	/**
	 * Switch models.
	 *
	 * `deferred` mirrors OMP: while a turn is streaming the switch is queued and
	 * applied at the next settle, because swapping the model mid-stream would
	 * invalidate the turn in flight.
	 */
	| { kind: "apply"; model: Model<Api>; thinkingLevel?: string; deferred: boolean; reason: string };

/** True when two models are the same route, by provider and id. */
function sameModel(a: Model<Api> | undefined, b: Model<Api> | undefined): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}

/**
 * Decides the model transition for entering plan mode.
 *
 * Returns a *decision*, never a model that bypasses eligibility: the caller passes
 * candidates that already survived every gate, and an empty list is the common
 * case when the role is unconfigured or its target is unreachable.
 */
export function resolvePlanModelTransition(input: {
	/** The model the session is on now. */
	current: Model<Api> | undefined;
	/** Candidates from the `plan` role, already eligibility-filtered. */
	candidates: readonly RoleChainCandidate[];
	/** True when a turn is streaming, so the switch must be deferred. */
	isStreaming: boolean;
	/** Thinking level the user configured for the plan role, if any. */
	thinkingLevel?: string;
}): PlanModelTransition {
	const { current, candidates, isStreaming } = input;

	// OMP's first rule: an unresolvable role means no transition at all. Preserved
	// because it means an unconfigured role never moves the user off their model.
	if (candidates.length === 0) {
		return { kind: "none", reason: "No usable plan-role candidate; keeping the current model." };
	}

	const next = candidates[0]?.model;
	if (!next) {
		return { kind: "none", reason: "Plan role produced no model; keeping the current model." };
	}

	// OMP's third rule: an implicit thinking level never overrides. Only a level the
	// operator actually configured is carried across.
	const thinkingLevel = input.thinkingLevel;

	if (sameModel(current, next)) {
		return thinkingLevel
			? {
					kind: "thinking",
					thinkingLevel,
					reason: "Plan role names the current model; applying its thinking level.",
				}
			: { kind: "none", reason: "Plan role names the model already in use." };
	}

	return {
		kind: "apply",
		model: next,
		...(thinkingLevel ? { thinkingLevel } : {}),
		deferred: isStreaming,
		reason: isStreaming
			? "Plan model switch deferred until the current turn settles."
			: "Switching to the plan model.",
	};
}

/**
 * The transition for leaving plan mode.
 *
 * OMP restores the pre-plan model rather than re-resolving the role
 * (`#restorePlanPreviousModel`, `interactive-mode.ts:4300-4314`). Kept: the user
 * chose a model before planning, and the plan role was a planning-time device.
 *
 * An approved plan does not keep the plan model in place. The plan is guidance
 * delivered as text, not a reason to hold a different model for the rest of the
 * session.
 */
export function resolvePlanExitTransition(input: {
	current: Model<Api> | undefined;
	/** The model captured when plan mode was entered, if one was. */
	restoreTo: Model<Api> | undefined;
	isStreaming: boolean;
}): PlanModelTransition {
	const { current, restoreTo, isStreaming } = input;

	if (!restoreTo) {
		return { kind: "none", reason: "No pre-plan model was captured; keeping the current model." };
	}
	if (sameModel(current, restoreTo)) {
		return { kind: "none", reason: "Already on the pre-plan model." };
	}
	return {
		kind: "apply",
		model: restoreTo,
		deferred: isStreaming,
		reason: isStreaming
			? "Pre-plan model restore deferred until the current turn settles."
			: "Restoring the pre-plan model.",
	};
}

/**
 * Builds the eligibility input for a plan-role resolution.
 *
 * Free-only is passed through unchanged rather than defaulted, because a plan must
 * not become a way to reach a paid model: the session's live policy is the only
 * acceptable input, and an absent policy is treated as the most restrictive.
 */
export function planRoleEligibility(input: {
	sessionModel: Model<Api> | undefined;
	policy: "off" | "same-provider" | "free-only" | "compatible" | undefined;
	credentialMissing?: (provider: string) => boolean;
	disabledProviders: ReadonlySet<string>;
}): RoleEligibility {
	return {
		sessionModel: input.sessionModel,
		// An unset policy is the most restrictive, so an unconfigured session cannot
		// accidentally authorize a paid plan model.
		policy: input.policy ?? "free-only",
		credentialMissing: input.credentialMissing,
		disabledProviders: input.disabledProviders,
	};
}
