/**
 * Compaction thresholds: when a context is full enough to compact.
 *
 * ## Two limits, and either one may fire
 *
 * OMP exposes a percentage *and* an absolute token count. They answer different
 * questions and a user legitimately wants both: the percentage adapts to a
 * small model where 200k tokens is the whole window, and the absolute count
 * stops a 1M-token window from waiting until 99% before compacting, which is
 * past the point where a useful summary still fits.
 *
 * Pi's engine works in reserved tokens, so both are resolved to that here rather
 * than duplicating the comparison in the engine.
 *
 * ## A token limit overrides a percentage
 *
 * This is the rule the memory records, and it is worth restating because the
 * reverse reads more naturally. If a percentage threshold would fire *later*
 * than an absolute one, taking the percentage would ignore a limit the user
 * typed. So the more conservative of the two wins.
 *
 * ## Idle compaction is a different trigger with the same work
 *
 * Three inputs: enabled, a token floor, and a quiet period. The token floor is
 * what makes it worth doing — compacting a small context while idle costs an LLM
 * call to summarise nothing. And the quiet period matters because compaction
 * changes the session transcript, so doing it mid-thought would alter the
 * context a running turn is reasoning about.
 */

/** The compaction limits, as a user configures them. */
export interface CompactionThresholds {
	/** Percentage of the window, 0-100. Fires at or below this fill. */
	readonly thresholdPercent?: number;
	/** Absolute token count. Fires at or below this, regardless of window. */
	readonly thresholdTokens?: number;
	/**
	 * The reserve the settings layer resolved for this model, already carrying the
	 * per-model override.
	 *
	 * Present because the configured reserve **governs the trigger**, not just the
	 * compaction that follows: `_checkCompaction` used to overwrite it with a value
	 * derived only from `thresholdPercent`/`thresholdTokens`, so a model override of
	 * `compaction.reserveTokens` decided what compaction *kept* but not whether it
	 * ran. See `resolveCompactionLimits`.
	 */
	readonly reserveTokens?: number;
	/**
	 * Whether `reserveTokens` was **explicitly configured** rather than defaulted.
	 *
	 * Provenance, not value, decides the fallback: a user who types 16384 has chosen it
	 * and it wins even though it equals the default, whereas a *defaulted* 16384 on a
	 * window too small to hold it is impossible and the proportional reserve takes over.
	 * Matching by value would make those two indistinguishable.
	 */
	readonly reserveWasDefaulted?: boolean;
}

export interface ResolvedCompactionLimits {
	/** Tokens to reserve, matching the engine's own field. */
	readonly reserveTokens: number;
	/** The absolute trigger, for display. */
	readonly thresholdTokens?: number;
	/** Which limit decided the reserve, for an honest explanation. */
	readonly decidedBy: "none" | "percent" | "tokens" | "both";
}

/** The engine's default when neither limit is configured. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Share of the window reserved when a *defaulted* reserve cannot fit.
 *
 * 15%, matching the reference implementation
 * (`oh-my-pi/packages/agent/src/compaction/compaction.ts`, `resolveBudgetReserveTokens`).
 * Replaces the previous 85% trigger constant, which was a guess at the same quantity:
 * a defaulted 16,384 reserve leaves nothing usable on a small model, and "leave 15% of
 * the window" is both what the reference does and the more conservative reading - a
 * larger reserve compacts later.
 */
const PROPORTIONAL_RESERVE_FRACTION = 0.15;

/**
 * Resolves the configured limits into the engine's reserved-token field.
 *
 * The engine compares `contextTokens > contextWindow - reserveTokens`, so a *larger*
 * reserve fires *later*. Precedence, matching the reference implementation
 * (`oh-my-pi/packages/agent/src/compaction/compaction.ts`):
 *
 * 1. **`thresholdTokens`** — an explicit absolute limit. It is a trigger in its own
 *    right, not a way of deriving a reserve, and it takes priority.
 * 2. **`thresholdPercent`** — likewise an independent trigger, applied as a share of
    the window.
 * 3. **`reserveTokens`** — the settings layer's resolved reserve for this model,
 *    carrying the per-model override. This **governs the trigger** when neither
 *    threshold is set, which is what the setting promises.
 * 4. **`DEFAULT_RESERVE_TOKENS`** — and only when the reserve was *defaulted*, never
 *    explicitly configured.
 *
 * The step-4 guard exists because the default is an absolute count that predates small
 * windows: 16,384 on a 10,000-token model leaves no usable budget, and the comparison
 * would then be true on every turn. A **defaulted** reserve that cannot fit is replaced
 * by a proportional one. An **explicit** reserve always wins, even when it equals the
 * default, because provenance says the user chose it. That distinction is carried by
 * `reserveWasDefaulted` and never by comparing values.
 */
export function resolveCompactionLimits(input: {
	readonly contextWindow: number;
	readonly thresholds: CompactionThresholds;
	readonly defaultReserveTokens?: number;
}): ResolvedCompactionLimits {
	const fallback = input.defaultReserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const { contextWindow } = input;
	// A non-positive window makes every percentage meaningless; falling back to the
	// default reserve is better than dividing by it.
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;

	const percent = input.thresholds.thresholdPercent;
	const tokens = input.thresholds.thresholdTokens;

	// 1 + 2: an explicit threshold is an independent trigger, not a source of reserve.
	const percentTrigger =
		window > 0 && typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100
			? Math.floor((window * Math.min(99, Math.max(1, percent))) / 100)
			: undefined;
	const tokenTrigger =
		typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;

	if (percentTrigger !== undefined || tokenTrigger !== undefined) {
		// Fixed token limit takes priority over percentage, matching the reference.
		// Each is clamped to [1, window - 1] so the trigger never reaches the whole
		// window, which would leave no room for the response.
		const trigger = Math.min(
			window > 0 ? window - 1 : Number.MAX_SAFE_INTEGER,
			tokenTrigger ?? Number.MAX_SAFE_INTEGER,
			percentTrigger ?? Number.MAX_SAFE_INTEGER,
		);
		const decidedBy =
			percentTrigger === undefined
				? "tokens"
				: tokenTrigger === undefined
					? "percent"
					: tokenTrigger === percentTrigger
						? "both"
						: tokenTrigger < percentTrigger
							? "tokens"
							: "percent";
		return {
			reserveTokens: window > 0 ? Math.max(0, window - trigger) : fallback,
			thresholdTokens: tokenTrigger,
			decidedBy,
		};
	}

	// 3 + 4: no threshold, so the configured reserve governs the trigger.
	const configured = input.thresholds.reserveTokens;
	const reserveTokens = Math.max(0, configured ?? fallback);
	const proportional = Math.max(1, Math.floor(window * PROPORTIONAL_RESERVE_FRACTION));
	const wasDefaulted = input.thresholds.reserveWasDefaulted ?? configured === undefined;
	const defaultedReserveIsImpossible = wasDefaulted && window > 0 && reserveTokens >= window - proportional;
	const reserveExceedsWindow = window > 0 && reserveTokens >= window;

	const effective =
		defaultedReserveIsImpossible || reserveExceedsWindow ? (window > 0 ? proportional : fallback) : reserveTokens;

	return {
		reserveTokens: effective,
		decidedBy: "none",
	};
}

/** What the idle path decided about a session that has gone quiet. */
export type IdleCompactionDecision =
	| { readonly compact: false; readonly reason: "disabled" | "below-threshold" | "not-idle" }
	| { readonly compact: true; readonly reason: "idle-and-full" };

export interface IdleCompactionInput {
	readonly enabled: boolean;
	/** Current context tokens. */
	readonly contextTokens: number;
	/** Token floor above which compacting while idle is worth an LLM call. */
	readonly thresholdTokens: number;
	/** Milliseconds since the session last did something. */
	readonly idleMs: number;
	/** The configured quiet period, in the same unit as `idleMs`. */
	readonly timeoutMs: number;
}

/**
 * Decides whether an idle session should compact.
 *
 * Order matters. The token floor is checked before the quiet period because it
 * is the cheaper test and the more decisive one: a small context is not worth an
 * LLM call however long it has been quiet.
 */
export function decideIdleCompaction(input: IdleCompactionInput): IdleCompactionDecision {
	if (!input.enabled) return { compact: false, reason: "disabled" };
	// Below the floor, compacting summarises almost nothing and still costs a call.
	if (input.contextTokens < input.thresholdTokens) return { compact: false, reason: "below-threshold" };
	// Compaction rewrites the transcript, so doing it while a turn is in flight would
	// alter the context that turn is reasoning about.
	if (input.idleMs < input.timeoutMs) return { compact: false, reason: "not-idle" };
	return { compact: true, reason: "idle-and-full" };
}
