/**
 * Per-provider in-flight request limits.
 *
 * ## Why the limit is per provider and not global
 *
 * Providers rate-limit independently, so a limit that did not name a provider
 * would have to be the strictest across all of them - a setting meant to protect
 * one provider would throttle every other. Omitted providers are unlimited,
 * because a limit nobody asked for is a limit nobody can explain.
 *
 * ## Why it spans processes
 *
 * Two local sessions against the same account share one provider quota, so a
 * per-process counter would let N processes each believe it had the whole
 * allowance. The limit is therefore resolved against a shared view of what is in
 * flight, keyed by provider.
 *
 * ## A limit of zero means unlimited, not nothing
 *
 * `0`, a negative number, and a non-number are all rejected rather than coerced.
 * Coercing `0` to "unlimited" would silently discard a value the user typed,
 * and coercing it to "no requests" would hang every request. Rejecting names the
 * providers at fault, so a user can find the typo.
 */

/** A limit per provider id. Absent means unlimited. */
export type ProviderLimits = Readonly<Record<string, number>>;

export class InvalidProviderLimitError extends Error {
	readonly providers: readonly string[];

	constructor(providers: readonly string[]) {
		super(`Provider request limits must be positive numbers: ${providers.join(", ")}`);
		this.name = "InvalidProviderLimitError";
		this.providers = providers;
	}
}

/** Whether a value is a usable positive limit. */
function isPositiveLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Whether a value is shaped like a provider limit record at all. */
function isLimitRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a configured limit map.
 *
 * Throws rather than dropping a bad entry: a silently-ignored limit means the
 * user believes they are protected and are not.
 */
export function validateProviderLimits(value: unknown): ProviderLimits {
	if (!isLimitRecord(value)) return {};
	const invalid: string[] = [];
	for (const [provider, limit] of Object.entries(value)) {
		if (!isPositiveLimit(limit)) invalid.push(provider);
	}
	if (invalid.length > 0) throw new InvalidProviderLimitError(invalid);
	return { ...(value as Record<string, number>) };
}

/** The limit for a provider, or `undefined` when it is unlimited. */
export function limitFor(limits: ProviderLimits, provider: string): number | undefined {
	return isPositiveLimit(limits[provider]) ? limits[provider] : undefined;
}

/** One provider's live request count. */
export interface ProviderUsage {
	readonly provider: string;
	readonly inFlight: number;
	/** A ceiling reported by the provider itself, which a local limit cannot exceed. */
	readonly providerCeiling?: number;
}

export type AdmitDecision =
	| { readonly admit: true; readonly waited: number }
	| { readonly admit: false; readonly reason: string; readonly inFlight: number; readonly limit: number };

/**
 * Whether a request may start now.
 *
 * The **effective** limit is the smaller of the configured one and the provider's
 * own ceiling, because a local limit above what the provider allows produces
 * rate-limit errors rather than throughput - and a rate-limit error costs the
 * request, not just the queue slot.
 */
export function admitRequest(input: { limits: ProviderLimits; usage: ProviderUsage }): AdmitDecision {
	const { limits, usage } = input;
	const configured = limitFor(limits, usage.provider);
	if (configured === undefined) {
		// Omitted means unlimited, and a limit nobody asked for is a limit nobody can
		// explain.
		return { admit: true, waited: 0 };
	}
	const effective = usage.providerCeiling === undefined ? configured : Math.min(configured, usage.providerCeiling);
	if (usage.inFlight < effective) return { admit: true, waited: 0 };
	return {
		admit: false,
		reason:
			usage.providerCeiling !== undefined && usage.providerCeiling < configured
				? `${usage.provider} is already at its own ceiling of ${usage.providerCeiling}`
				: `${usage.provider} already has ${usage.inFlight} of ${effective} requests in flight`,
		inFlight: usage.inFlight,
		limit: effective,
	};
}

/**
 * How long to wait before retrying an admission decision.
 *
 * Grows with the queue depth, because a fixed wait for a deep queue retries
 * into the same wall. Bounded, because an unbounded backoff on a stuck provider
 * stalls the session rather than reporting a problem.
 */
export function backoffMs(attempts: number, baseMs = 250, maxMs = 10_000): number {
	if (attempts <= 0) return 0;
	const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempts - 1, 16));
	// Jitter, so a burst of waiters does not retry in lockstep and re-create the
	// contention it is waiting out.
	const jitter = exponential * 0.25 * Math.random();
	return Math.min(maxMs, Math.round(exponential - exponential * 0.125 + jitter));
}

/** One line for a settings hint, naming what unlimited means. */
export function describeLimits(limits: ProviderLimits): string {
	const named = Object.keys(limits);
	if (named.length === 0) return "No provider is limited; every request starts immediately.";
	return `Limited: ${named.join(", ")}. A provider with no entry is unlimited.`;
}
