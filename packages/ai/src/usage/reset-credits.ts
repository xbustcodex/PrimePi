/**
 * Saved rate-limit reset credits: whether to spend one, and which.
 *
 * ## What a "reset credit" is
 *
 * Providers hand back a perishable credit that clears a rate-limit window. The
 * credit is a limited resource with an expiry, so the questions are always the
 * same two: may this be spent, and which one?
 *
 * ## Three states, not a boolean
 *
 * - **`unset`** — ask before the *first* spend, then remember the answer for the
 *   session. A boolean has nowhere to put "ask once", and asking on every spend
 *   makes the feature unusable while never asking at all makes it unilateral.
 * - **`yes`** — spend without prompting.
 * - **`no`** — disable both the rescue and the salvage.
 *
 * ## The gate is narrow on purpose
 *
 * A credit is spent only when a turn is **stuck** *and* **no other account can
 * take over**. A credit spent on a turn that was merely slow is a resource
 * destroyed for nothing, and one spent while a healthy account sat idle is worse
 * still.
 *
 * ## Expiry order, not arbitrary order
 *
 * Credits are perishable, so spending the soonest-expiring one maximises the
 * bank's lifetime value. A credit without a parseable expiry ranks *after* every
 * dated one — undated credits are the ones most likely to never expire, so they
 * are the ones worth keeping longest.
 *
 * ## Idempotency is the caller's job, and the key is the mechanism
 *
 * `redeemRequestId` is the idempotency key. Retrying with the *same* id is safe
 * and will not double-spend; retrying with a fresh one will. A caller that
 * generates a new key per attempt has built a double-spend, and no amount of
 * checking at this layer can catch it.
 */

/** A single redeemable (or already-spent) saved reset. */
export interface ResetCredit {
	readonly id: string;
	/** Backend reset family, e.g. `codex_rate_limits`. */
	readonly resetType?: string;
	readonly status?: string;
	readonly grantedAt?: string;
	readonly expiresAt?: string;
	readonly redeemedAt?: string | null;
	readonly title?: string;
	readonly description?: string;
}

/** Whether the user has permitted spending. */
export type AutoRedeemPolicy = "unset" | "yes" | "no";

/** Why a redeem was or was not attempted. */
export type RedeemDecision =
	| { readonly action: "spend"; readonly credit: ResetCredit; readonly reason: string }
	| { readonly action: "ask"; readonly credit: ResetCredit; readonly reason: string }
	| { readonly action: "skip"; readonly reason: string };

/** Why a turn is a candidate for rescue. */
export interface StuckTurnEvidence {
	/** The turn could not proceed: every account was blocked. */
	readonly everyAccountBlocked: boolean;
	/** Another account could have taken the turn over. */
	readonly alternativeAccountAvailable: boolean;
	/** Credits that are redeemable now. */
	readonly credits: readonly ResetCredit[];
	readonly now: number;
}

/** Credits that are redeemable, treating an absent status as available. */
function availableCredits(credits: readonly ResetCredit[]): readonly ResetCredit[] {
	return credits.filter((credit) => (credit.status ?? "available") === "available");
}

/** Parsed expiry, or `undefined` when absent or unparseable. */
function expiryOf(credit: ResetCredit): number | undefined {
	if (!credit.expiresAt) return undefined;
	const parsed = Date.parse(credit.expiresAt);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The credit to spend: the available one that expires soonest.
 *
 * Undated credits rank after every dated one, because an undated credit is the
 * one most likely to never expire and therefore the one worth keeping longest.
 * When nothing is available the first credit is returned unchanged, and the
 * consume surfaces the backend's own outcome rather than this layer guessing.
 */
export function pickSoonestExpiringCredit(credits: readonly ResetCredit[]): ResetCredit | undefined {
	let best: ResetCredit | undefined;
	let bestExpiry = Number.POSITIVE_INFINITY;
	let undated: ResetCredit | undefined;
	for (const credit of credits) {
		if ((credit.status ?? "available") !== "available") continue;
		const expiry = expiryOf(credit);
		if (expiry === undefined) {
			undated ??= credit;
			continue;
		}
		if (expiry < bestExpiry) {
			best = credit;
			bestExpiry = expiry;
		}
	}
	return best ?? undated ?? credits[0];
}

/**
 * Decides whether a stuck turn may spend a credit.
 *
 * Pure with respect to the caller, so every branch is reachable in a test with
 * no network and no clock.
 */
export function decideRedeem(policy: AutoRedeemPolicy, evidence: StuckTurnEvidence): RedeemDecision {
	if (policy === "no") {
		return { action: "skip", reason: "automatic redemption is disabled" };
	}
	// The gate is narrow on purpose: a credit spent on a merely-slow turn is a
	// resource destroyed for nothing.
	if (!evidence.everyAccountBlocked) {
		return { action: "skip", reason: "not every account was blocked, so this is not a rescue" };
	}
	if (evidence.alternativeAccountAvailable) {
		// Spending while a healthy account sits idle is worse than not spending.
		return { action: "skip", reason: "another account could have taken the turn over" };
	}
	const available = availableCredits(evidence.credits);
	if (available.length === 0) {
		return { action: "skip", reason: "no redeemable credit is available" };
	}
	const credit = pickSoonestExpiringCredit(available);
	if (!credit) return { action: "skip", reason: "no credit could be selected" };
	// `unset` asks once; the answer is remembered by the caller for the session.
	if (policy === "unset") {
		return { action: "ask", credit, reason: "spending a saved reset needs confirmation the first time" };
	}
	return { action: "spend", credit, reason: "no other account can take over and a credit is available" };
}

/**
 * Credits about to expire, within a horizon.
 *
 * The salvage path is separate from the rescue path: a credit nobody needs can
 * still be worth spending before it lapses. The horizon is what makes it
 * deliberate rather than a reflex.
 */
export function creditsExpiringWithin(credits: readonly ResetCredit[], now: number, horizonMs: number): ResetCredit[] {
	return availableCredits(credits)
		.map((credit) => ({ credit, expiry: expiryOf(credit) }))
		.filter((entry): entry is { credit: ResetCredit; expiry: number } => entry.expiry !== undefined)
		.filter((entry) => entry.expiry > now && entry.expiry - now <= horizonMs)
		.sort((left, right) => left.expiry - right.expiry)
		.map((entry) => entry.credit);
}

/** Whether a policy has been answered for this session. */
export function isAnswered(policy: AutoRedeemPolicy): boolean {
	return policy === "yes" || policy === "no";
}

/**
 * The idempotency key for one redeem attempt.
 *
 * Generated once per attempt and reused across retries. A caller that
 * regenerates it has built a double-spend, and no check at this layer can catch
 * it — the key is the whole mechanism.
 */
export function mintRedeemRequestId(seed?: () => string): string {
	return (seed ?? (() => globalThis.crypto.randomUUID()))();
}
