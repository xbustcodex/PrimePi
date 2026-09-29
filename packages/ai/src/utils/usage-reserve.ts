/**
 * Usage-aware fallback: what happens when the plan is nearly spent.
 *
 * ## The states, and what each one is allowed to do
 *
 * A coding-plan account reports a remaining fraction. That resolves to one of
 * four states, and the *state* — not the number — is what a caller acts on:
 *
 * - `healthy` — above the reserve margin. Nothing to do.
 * - `unknown` — the provider did not report usage, or it could not be mapped.
 *   **Treated as healthy.** Failing closed on an unknown would block every
 *   session against a provider that simply does not publish usage, which is a
 *   worse failure than spending the margin.
 * - `reserve` — below the margin but not yet spent. The margin exists to leave
 *   room to finish the current turn, so the account is not used for new work.
 * - `depleted` — spent.
 *
 * ## `fail-closed` is about *new work*, not about the session
 *
 * A fail-closed policy throws when the primary is in reserve or depleted, even
 * if a healthy account exists. That is the point: the user asked not to spend
 * the margin, and silently switching to a different account spends it anyway
 * while reporting a normal turn. Failing loudly is the only outcome that
 * honours the setting.
 *
 * ## A candidate must also fit the context
 *
 * A fallback that clears usage can still be wrong if the target model's window
 * cannot hold the live context. Switching onto it converts a usage problem into
 * a context-overflow one, which is strictly worse and much more confusing. So a
 * candidate whose window cannot fit is skipped, not tried.
 *
 * ## Approval is remembered per selector, not globally
 *
 * Under `confirm`, the user approves one selector. Approving `provider/model-a`
 * says nothing about `provider/model-b`, and the approval is dropped as soon as
 * the state returns to healthy — so a later excursion into reserve asks again
 * rather than inheriting a decision made for a different situation.
 */

export type UsageHealthState = "healthy" | "reserve" | "depleted" | "unknown";

/** What a caller may do about a given state. */
export type ReservePolicy = "confirm" | "auto" | "fail-closed";

export interface UsageAccount {
	readonly id: string;
	/** Remaining fraction, 0-1. */
	readonly remaining: number;
	/** The account's own state, classified against the same margin. */
	readonly state?: UsageHealthState;
	readonly selected?: boolean;
}

export interface UsageHealth {
	readonly state: UsageHealthState;
	readonly accounts: readonly UsageAccount[];
}

export interface ReserveInput {
	/** Remaining fraction 0-1, or null when the provider reported nothing usable. */
	readonly remaining: number | null;
	/** Below this fraction the account is inside the margin. */
	readonly reserveFraction: number;
	readonly accounts?: readonly UsageAccount[];
}

/**
 * Classifies usage.
 *
 * An unusable reading resolves to `unknown` rather than `depleted`. A provider
 * that publishes no usage is not a provider that is out of usage, and conflating
 * the two would make every session on such a provider fail closed.
 */
export function classifyUsage(input: ReserveInput): UsageHealth {
	if (input.remaining === null || !Number.isFinite(input.remaining)) {
		return { state: "unknown", accounts: input.accounts ?? [] };
	}
	// A negative reserve fraction would mark every account as inside the margin.
	const margin = Math.max(0, Math.min(1, input.reserveFraction));
	const remaining = Math.max(0, Math.min(1, input.remaining));
	const state: UsageHealthState = remaining <= 0 ? "depleted" : remaining < margin ? "reserve" : "healthy";
	return { state, accounts: input.accounts ?? [] };
}

/** What a policy does with a state. */
export type ReserveDecision =
	| { readonly action: "proceed" }
	| { readonly action: "confirm"; readonly reason: string }
	| { readonly action: "fail-closed"; readonly reason: string };

/**
 * Applies the policy to the primary's health.
 *
 * `approvedSelector` is the selector the user has already approved, or
 * undefined. It is only consulted under `confirm`, and only for a `reserve`
 * state — a *depleted* account is never silently reused on an old approval,
 * because the user approved spending the margin, not spending the account.
 */
export function decideReserveAction(input: {
	readonly policy: ReservePolicy;
	readonly health: UsageHealth;
	readonly selector: string;
	readonly approvedSelector?: string;
}): ReserveDecision {
	const { state } = input.health;
	if (state === "healthy" || state === "unknown") {
		// Unknown is deliberately a pass: failing closed on an unreported reading
		// would block sessions against providers that do not publish usage.
		return { action: "proceed" };
	}
	const condition = state === "reserve" ? "reserve reached" : "usage depleted";
	if (input.policy === "fail-closed") {
		// Throws even when a healthy account exists. Silently switching spends the
		// margin while reporting a normal turn, which is exactly what the setting
		// forbids.
		return { action: "fail-closed", reason: `${condition} for ${input.selector}; reserve policy is fail-closed` };
	}
	if (input.policy === "confirm" && state === "reserve" && input.approvedSelector === input.selector) {
		return { action: "proceed" };
	}
	return { action: "confirm", reason: `${condition} for ${input.selector}` };
}

/** Why a candidate model is not a usable fallback, or undefined when it is. */
export type RejectionReason = "depleted" | "reserve" | "unknown" | "context-overflow" | "no-auth" | "unavailable";

export interface CandidateCheck {
	readonly candidate: string;
	readonly usable: boolean;
	readonly reason?: RejectionReason;
}

/**
 * Decides whether a candidate can take over.
 *
 * Usage is checked *and* fit, in that order, and both must pass. A candidate
 * that clears usage but cannot hold the live context would convert a usage
 * problem into a context-overflow one, which is strictly worse and far more
 * confusing to diagnose.
 */
export function evaluateCandidate(input: {
	readonly candidate: string;
	readonly health: UsageHealth;
	/** False when the candidate's window cannot hold the live context. */
	readonly contextFits: boolean;
	readonly hasConfiguredAuth: boolean;
	/** False when the provider does not offer the model at all. */
	readonly available?: boolean;
}): CandidateCheck {
	if (input.available === false) return { candidate: input.candidate, usable: false, reason: "unavailable" };
	if (!input.hasConfiguredAuth) return { candidate: input.candidate, usable: false, reason: "no-auth" };
	// Fit before usage: a candidate that cannot hold the context is wrong regardless
	// of how much of the plan is left.
	if (!input.contextFits) return { candidate: input.candidate, usable: false, reason: "context-overflow" };
	if (input.health.state === "depleted") return { candidate: input.candidate, usable: false, reason: "depleted" };
	if (input.health.state === "reserve") return { candidate: input.candidate, usable: false, reason: "reserve" };
	// An unknown reading does not block a candidate: the candidate may still be the
	// only route, and refusing every candidate on unreadable usage would end the
	// turn with nothing.
	return { candidate: input.candidate, usable: true };
}

/**
 * Whether the session's account lease should be released.
 *
 * A selected account that is not healthy, while another account on the same
 * provider is, means the lease is pinned to a worse account than necessary. The
 * lease is released so the next request can take the healthy one.
 */
export function shouldReleaseAccountLease(input: {
	readonly health: UsageHealth;
	readonly selectedAccountState?: UsageHealthState;
}): boolean {
	if (input.health.state === "healthy") return false;
	const selected = input.selectedAccountState;
	if (selected === undefined || selected === "healthy") return false;
	return input.health.accounts.some((account) => account.state === "healthy");
}

/** An account's own state, derived from its remaining fraction. */
export function accountState(account: UsageAccount, reserveFraction: number): UsageHealthState {
	return classifyUsage({ remaining: account.remaining, reserveFraction }).state;
}
