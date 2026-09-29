/**
 * When context maintenance runs, and which method it uses.
 *
 * ## The order is a preference, not a requirement
 *
 * Server-native compaction first because it is the only method that *reduces*
 * what the provider holds rather than what the client sends, and a portable
 * summary last because every method is expected to work. An unavailable or
 * failed method **advances to the next** rather than failing the turn — a
 * maintenance method that cannot run must not take the session down with it.
 *
 * `shake` sits above `soft` because dropping recoverable content costs nothing:
 * no LLM call, no latency, no model that might summarise badly. It is the right
 * first *local* method and the wrong only method, which is why it precedes the
 * summarising fallback and follows the two that actually reduce context.
 *
 * ## Two thresholds, and which one wins
 *
 * A **token** limit is absolute: it fires at the same point regardless of how
 * large the model's window is. A **percent** threshold is relative: it fires at
 * the same *fraction* of whatever window is in use, so the same setting behaves
 * sensibly on a 200K and a 1M model.
 *
 * When both are set, the token limit wins. It is the more specific statement,
 * and a percentage that would have fired later cannot override an absolute
 * limit the user typed.
 *
 * `-1` on either means *not set*, and with neither set the legacy reserve-based
 * behaviour applies — which is the reference's default and is deliberately not
 * replaced by a percentage.
 *
 * ## Idle maintenance is separate
 *
 * Compacting during a turn interrupts it. Compacting while the session is *idle*
 * costs the user nothing, so it is a separate trigger with its own threshold and
 * its own delay, and it is off by default.
 */

import type { CompactionMethod } from "./methods.ts";

/** Sentinel meaning "not set". */
const UNSET = -1;

export interface CompactionThresholds {
	/** Percent of the context window. `-1` is not set. */
	readonly thresholdPercent: number;
	/** Absolute token limit. `-1` is not set. Overrides the percentage. */
	readonly thresholdTokens: number;
	/** The active model's context window, for resolving a percentage. */
	readonly contextWindowTokens: number;
}

/** The trigger, and why. */
export interface CompactionThreshold {
	/** Tokens at which maintenance runs. */
	readonly atTokens: number;
	/** Which setting produced it, for a status line. */
	readonly source: "tokens" | "percent" | "reserve";
}

/**
 * Tokens of the context window kept free by default.
 *
 * The legacy reserve behaviour: compact when the window is nearly full rather
 * than at a fixed fraction. Chosen so the session does not have to compact
 * repeatedly as the window fills.
 */
export const DEFAULT_RESERVE_TOKENS = 32_000;

/** Resolves the trigger. */
export function resolveCompactionThreshold(input: CompactionThresholds): CompactionThreshold {
	// The more specific statement wins: a percentage that would fire later cannot
	// override an absolute limit the user typed.
	if (Number.isFinite(input.thresholdTokens) && input.thresholdTokens > UNSET) {
		return { atTokens: Math.trunc(input.thresholdTokens), source: "tokens" };
	}
	if (Number.isFinite(input.thresholdPercent) && input.thresholdPercent > UNSET) {
		const window = input.contextWindowTokens > 0 ? input.contextWindowTokens : 0;
		if (window > 0) {
			const fraction = Math.min(100, Math.max(1, input.thresholdPercent)) / 100;
			return { atTokens: Math.floor(window * fraction), source: "percent" };
		}
		// A percentage with no window to apply it to falls through to the reserve,
		// which is a real number rather than a division by zero.
	}
	const window = input.contextWindowTokens > 0 ? input.contextWindowTokens : 0;
	return { atTokens: Math.max(0, window - DEFAULT_RESERVE_TOKENS), source: "reserve" };
}

/** What a compaction trigger decides for a session. */
export interface TriggerDecision {
	readonly compact: boolean;
	/** How full the context is, 0 to 1. */
	readonly fillRatio: number;
	readonly reason: string;
}

/** Whether context maintenance should run now. */
export function decideCompaction(input: {
	readonly usedTokens: number;
	readonly thresholds: CompactionThresholds;
	/** Suppresses maintenance for this turn, for an operation that must not be interrupted. */
	readonly suppressed?: boolean;
}): TriggerDecision {
	const window = input.thresholds.contextWindowTokens;
	const fillRatio = window > 0 ? Math.min(1, input.usedTokens / window) : 0;
	// Maintenance mid-turn interrupts the turn, and a turn that must finish is
	// not a place to start summarising it.
	if (input.suppressed) return { compact: false, fillRatio, reason: "maintenance is suppressed for this turn" };
	if (input.usedTokens <= 0) return { compact: false, fillRatio, reason: "nothing is in the context yet" };
	const threshold = resolveCompactionThreshold(input.thresholds);
	if (input.usedTokens < threshold.atTokens) {
		return {
			compact: false,
			fillRatio,
			reason: `${input.usedTokens} tokens is under the ${threshold.atTokens} threshold`,
		};
	}
	return {
		compact: true,
		fillRatio,
		reason: `${input.usedTokens} tokens reached the ${threshold.atTokens} ${threshold.source} threshold`,
	};
}

/** A method that can be attempted right now. */
export interface MethodAvailability {
	readonly method: CompactionMethod;
	/** False when the active route cannot run it. */
	readonly available: boolean;
	readonly reason: string;
}

/**
 * Walks the method order, skipping what cannot run.
 *
 * A maintenance method that cannot run must not take the session down, so an
 * unavailable or failed method **advances to the next** in the order. An empty
 * result means every configured method failed, which the caller reports rather
 * than silently continuing with a full context.
 */
export function selectCompactionMethod(
	order: readonly CompactionMethod[],
	availability: readonly MethodAvailability[],
): { method: CompactionMethod; skipped: readonly string[] } | { unavailable: readonly string[] } {
	const byMethod = new Map(availability.map((entry) => [entry.method, entry]));
	const skipped: string[] = [];
	for (const method of order) {
		const entry = byMethod.get(method);
		if (entry && !entry.available) {
			skipped.push(`${method}: ${entry.reason}`);
			continue;
		}
		return { method, skipped };
	}
	return { unavailable: skipped };
}

/** Idle maintenance: a separate trigger, off by default. */
export interface IdleCompaction {
	readonly enabled: boolean;
	/** Fill that must be reached before an idle session is compacted. */
	readonly thresholdTokens: number;
	/** How long the session must be idle first, in seconds. */
	readonly delaySeconds: number;
}

export const DEFAULT_IDLE_COMPACTION: IdleCompaction = {
	enabled: false,
	thresholdTokens: 50_000,
	delaySeconds: 300,
};

/** Whether an idle session should be compacted. */
export function decideIdleCompaction(
	config: IdleCompaction,
	context: { usedTokens: number; idleSeconds: number },
): { compact: boolean; reason: string } {
	// Compacting while idle costs the user nothing, which is why it is separate from
	// the in-turn trigger rather than a variation on it.
	if (!config.enabled) return { compact: false, reason: "idle compaction is off" };
	if (context.idleSeconds < config.delaySeconds) {
		return { compact: false, reason: `idle for ${context.idleSeconds}s, under the ${config.delaySeconds}s delay` };
	}
	if (context.usedTokens < config.thresholdTokens) {
		return {
			compact: false,
			reason: `${context.usedTokens} tokens is under the ${config.thresholdTokens} idle threshold`,
		};
	}
	return { compact: true, reason: "idle long enough with enough context to reclaim" };
}
