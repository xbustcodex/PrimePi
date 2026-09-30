/**
 * Retry budget and backoff.
 *
 * One place answers three questions the turn-recovery loop used to answer ad hoc:
 *
 * 1. May this request try again, and if not, what do we tell the user?
 * 2. How long do we wait before the next attempt?
 * 3. Does a provider-reported usage window get waited out, or do we fall back to
 *    ordinary backoff?
 *
 * The budget is per request, not per process: `planRetryAttempt` is pure and takes
 * the attempt number the caller already counts, so nothing here can accumulate
 * state across turns or across processes. Every wait is bounded twice — by the
 * agent backoff ceiling and, when configured, by `retry.maxDelayMs` — so a
 * provider cannot park the session for hours by asking politely in a header.
 *
 * Failover is a separate dimension and deliberately absent from this file.
 * Switching models to escape an exhausted route is `selectFailoverCandidate`'s
 * decision; this module only bounds how many times one route is asked.
 */

import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type RetryPolicy, retryDelayMs } from "@earendil-works/pi-ai";

/**
 * The resolved retry policy for one request.
 *
 * `maxAgentDelayMs` is the agent's own backoff ceiling. `maxDelayMs` is
 * `retry.maxDelayMs`: `0` means "no extra ceiling", in which case
 * `maxAgentDelayMs` alone bounds a wait. A provider-reported reset is what
 * `maxDelayMs` exists to cap, which is why it can raise a single wait above the
 * backoff ceiling when set explicitly and lower it when set low.
 */
export interface RetryPolicyResolution extends RetryPolicy {
	/** Registered as `retry.maxRetries`; bounds automatic retries per request. */
	maxRetries: number;
	/** Registered as `retry.maxDelayMs`; `0` disables the extra ceiling. */
	maxDelayMs: number;
	/** Registered as `retry.waitForUsageReset`; wait out a reported usage window. */
	waitForUsageReset: boolean;
}

/** The subset of the settings registry this module reads. */
export type RegisteredSettingReader = (key: string) => { value: unknown; isExplicit: boolean } | undefined;

/** Legacy `settings.retry` fields that have no registered descriptor. */
export interface LegacyRetrySettings {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	maxAgentDelayMs?: number;
	maxDelayMs?: number;
	waitForUsageReset?: boolean;
}

/** Documented defaults, matching `docs/settings.md`. */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000;

function nonNegativeInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.trunc(value);
}

/**
 * Resolves one setting: an explicitly configured registered value wins, then the
 * legacy field, then the documented default.
 *
 * `isExplicit` matters. A registered key that nobody set resolves to its
 * descriptor default, and those defaults predate this wiring (`retry.maxRetries`
 * defaulted to `0`, which would silently disable every retry). Falling through to
 * the documented default instead of trusting an unset descriptor is what keeps
 * resolution honest.
 */
function resolve<T>(
	reader: RegisteredSettingReader,
	key: string,
	read: (value: unknown) => T | undefined,
	legacy: T | undefined,
	fallback: T,
): T {
	const registered = reader(key);
	if (registered?.isExplicit) {
		const parsed = read(registered.value);
		if (parsed !== undefined) return parsed;
	}
	return legacy !== undefined ? legacy : fallback;
}

/**
 * The retry policy one request should run under.
 *
 * Reads the registered keys so a mid-session change takes effect on the next turn
 * and a malformed value is rejected by the same parser the settings UI used,
 * rather than being read raw from the settings tree.
 */
export function resolveRetryPolicy(input: {
	registered: RegisteredSettingReader;
	legacy: LegacyRetrySettings | undefined;
}): RetryPolicyResolution {
	const { registered, legacy } = input;
	return {
		enabled: resolve(
			registered,
			"retry.enabled",
			(value) => (typeof value === "boolean" ? value : undefined),
			legacy?.enabled,
			true,
		),
		maxRetries: resolve(registered, "retry.maxRetries", nonNegativeInt, legacy?.maxRetries, DEFAULT_MAX_RETRIES),
		baseDelayMs: resolve(registered, "retry.baseDelayMs", nonNegativeInt, legacy?.baseDelayMs, DEFAULT_BASE_DELAY_MS),
		maxAgentDelayMs: resolve(
			registered,
			"retry.maxAgentDelayMs",
			nonNegativeInt,
			legacy?.maxAgentDelayMs,
			DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		),
		maxDelayMs: resolve(registered, "retry.maxDelayMs", nonNegativeInt, legacy?.maxDelayMs, 0),
		waitForUsageReset: resolve(
			registered,
			"retry.waitForUsageReset",
			(value) => (typeof value === "boolean" ? value : undefined),
			legacy?.waitForUsageReset,
			true,
		),
	};
}

/** The outcome of asking whether one request may try again. */
export type RetryDecision =
	| { kind: "disabled" }
	| {
			kind: "exhausted";
			/** Retries actually spent, so a report never claims a retry that did not happen. */
			attempts: number;
			maxRetries: number;
			/** Distinct, actionable terminal message; never the bare provider error. */
			message: string;
	  }
	| {
			kind: "retry";
			/** 1-based attempt number about to be made. */
			attempt: number;
			delayMs: number;
			/** The wait is for a provider-reported reset rather than ordinary backoff. */
			waitingForUsageReset: boolean;
	  };

function minDelay(...delays: (number | undefined)[]): number {
	let result = Number.MAX_SAFE_INTEGER;
	for (const delay of delays) {
		if (delay === undefined) continue;
		result = Math.min(result, Math.max(0, delay));
	}
	return result;
}

/** Saturating `base + delta`, so a provider reset time cannot produce `NaN`. */
function saturatedDelta(untilMs: number, now: number): number {
	const delta = untilMs - now;
	if (!Number.isFinite(delta)) return Number.MAX_SAFE_INTEGER;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, delta));
}

/**
 * The terminal message for a spent budget.
 *
 * It names the attempt count, the setting that bounded it, and the underlying
 * provider error, because "the provider returned 529" alone tells the user
 * nothing about why the turn stopped or what to change.
 */
export function describeRetryExhaustion(input: { attempts: number; maxRetries: number; errorMessage: string }): string {
	const providerError = input.errorMessage.trim() || "unknown provider error";
	return `Retry budget exhausted: ${input.attempts} of ${input.maxRetries} automatic retries used (retry.maxRetries). Last provider error: ${providerError}`;
}

/**
 * Whether a failed request may try again, and how long to wait first.
 *
 * `attempt` is 1-based and counts retries, not the initial call: the initial call
 * never consumes budget, so `maxRetries: 0` means one call and no retry. The
 * budget is checked before the wait, so a request can never sleep its way past
 * the ceiling it was given.
 */
export function planRetryAttempt(input: {
	policy: RetryPolicyResolution;
	attempt: number;
	/** Epoch ms at which the provider says this route may work again. */
	resetAtMs?: number;
	/** The provider text behind the failure, quoted in the exhaustion message. */
	errorMessage?: string;
	now?: number;
}): RetryDecision {
	const { policy, attempt } = input;
	if (!policy.enabled) return { kind: "disabled" };

	const now = input.now ?? Date.now();
	if (attempt > policy.maxRetries) {
		const attempts = Math.max(0, attempt - 1);
		return {
			kind: "exhausted",
			attempts,
			maxRetries: policy.maxRetries,
			message: describeRetryExhaustion({
				attempts,
				maxRetries: policy.maxRetries,
				errorMessage: input.errorMessage ?? "",
			}),
		};
	}

	const ceilingMs = policy.maxDelayMs > 0 ? policy.maxDelayMs : undefined;
	const resetDelayMs = input.resetAtMs === undefined ? undefined : saturatedDelta(input.resetAtMs, now as number);

	if (resetDelayMs !== undefined && resetDelayMs > 0 && policy.waitForUsageReset) {
		// A reported window is waited out rather than retried into. The wait is still
		// bounded: `maxDelayMs` when configured, otherwise the agent ceiling, so a
		// provider asking for five hours cannot park the turn indefinitely.
		return {
			kind: "retry",
			attempt,
			delayMs: minDelay(resetDelayMs, ceilingMs ?? policy.maxAgentDelayMs),
			waitingForUsageReset: true,
		};
	}

	const backoffMs = retryDelayMs(
		{ baseDelayMs: policy.baseDelayMs, maxAgentDelayMs: policy.maxAgentDelayMs },
		attempt,
	);
	return { kind: "retry", attempt, delayMs: minDelay(backoffMs, ceilingMs), waitingForUsageReset: false };
}
