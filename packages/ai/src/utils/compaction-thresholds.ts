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
 * Where compaction fires on a window too small to hold `DEFAULT_RESERVE_TOKENS`.
 *
 * The default reserve is an absolute number of tokens, so it only expresses a sensible
 * idea on a window with that much headroom to spare. Below that, the equivalent intent
 * is a proportion of the window: compact once the context is **this** full. Chosen so a
 * window that exactly cannot hold the reserve lands near the trigger a large window
 * would reach for the same absolute headroom.
 */
const SMALL_WINDOW_TRIGGER_PERCENT = 85;

/**
 * Resolves the two configured limits into the engine's reserved-token field.
 *
 * The engine compares `contextTokens > contextWindow - reserveTokens`, so a
 * *lower* reserve fires *later*. Both configured limits are therefore converted
 * to the trigger point they describe, the earlier trigger is taken, and that is
 * turned back into a reserve.
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

	const percentTrigger =
		window > 0 && typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100
			? Math.floor((window * Math.min(100, percent)) / 100)
			: undefined;
	const tokenTrigger =
		typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;

	if (percentTrigger === undefined && tokenTrigger === undefined) {
		// **The fallback needs the same clamp as a configured trigger, and this is where
		// it was missing.** `shouldCompact` fires on
		// `contextTokens > contextWindow - reserveTokens`, so a reserve larger than the
		// window makes the right-hand side negative and the comparison true for ANY
		// context size. With DEFAULT_RESERVE_TOKENS at 16,384 that is every window below
		// 16k: compaction then ran on every single turn, however small the context, and
		// whatever reserve the caller passed in `settings` was never consulted here.
		//
		// Found through six failing tests that each looked like "an unexpected compaction
		// happened" - a message that reads as the threshold genuinely being crossed. The
		// fix is bounded to the unconfigured path and leaves every configured threshold
		// exactly as it was, including the deliberate absence of a cap at `fallback`.
		//
		// With no configured threshold, the engine default is expressed as a *reserve*:
		// compact when `contextTokens > contextWindow - reserveTokens`. The hazard is that
		// this reserve is absolute while the window is a property of the chosen model, so
		// on any window below DEFAULT_RESERVE_TOKENS the right-hand side goes negative and
		// compaction fires on **every turn**.
		//
		// Clamping it to the window is not sufficient either: reserve == window means
		// "fires above 0", which is the same defect in a smaller window. What has to be
		// preserved is the *ratio*: the default expresses 16,384 tokens of headroom,
		// which is meaningful on a 200k window and impossible on a 10k one.
		//
		// So on a window that cannot hold the default reserve, fall back to a percentage
		// that expresses the same intent - compact when the context is most of the way
		// full - rather than to a limit of zero. A window smaller than the default reserve
		// is a small-window model, and for those "nearly full" is the correct reading of
		// "16k of headroom", not "always full".
		if (window > 0 && fallback < window) {
			return { reserveTokens: fallback, decidedBy: "none" };
		}
		if (window > 0) {
			// The window cannot hold the default reserve. Use the percentage that the
			// default represents for a large window, so behaviour degrades smoothly.
			const trigger = Math.floor((window * SMALL_WINDOW_TRIGGER_PERCENT) / 100);
			return { reserveTokens: window - trigger, decidedBy: "percent" };
		}
		return { reserveTokens: fallback, decidedBy: "none" };
	}

	// The earlier trigger wins. A percentage that would fire *later* than an
	// absolute limit the user typed would silently ignore the typed one, so the
	// minimum is taken rather than letting either field win by precedence.
	const triggers: number[] = [];
	if (percentTrigger !== undefined) triggers.push(percentTrigger);
	if (tokenTrigger !== undefined) triggers.push(tokenTrigger);
	const trigger = Math.min(...triggers);

	const decidedBy =
		percentTrigger === undefined
			? "tokens"
			: tokenTrigger === undefined
				? "percent"
				: percentTrigger === tokenTrigger
					? "both"
					: trigger === tokenTrigger
						? "tokens"
						: "percent";

	// Clamped once, and the direction matters.
	//
	// The engine fires when `contextTokens > contextWindow - reserveTokens`, so a
	// *larger* reserve compacts *later*. What therefore has to be bounded is the
	// trigger: it must not fall below zero, and it must not exceed the window — a
	// negative reserve makes the comparison true on every single turn.
	//
	// There is deliberately **no cap at `fallback`**. Capping there would forbid a
	// user from compacting later than the engine default, which is a legitimate
	// choice on a large window. The first draft made exactly that mistake: it
	// clamped every configured reserve to 16k, so a 40% threshold was silently
	// rewritten as 8%.
	const safeTrigger = Math.max(0, Math.min(trigger, window));
	const reserveTokens = window > 0 ? Math.min(window, window - safeTrigger) : fallback;
	return {
		reserveTokens,
		thresholdTokens: tokenTrigger,
		decidedBy,
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
