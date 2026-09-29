/**
 * The status line: which segments appear, and how the context gauge reads.
 *
 * ## The segment catalog is a closed list
 *
 * Every segment identifier is enumerated rather than free text, because a
 * custom status line is user-authored *configuration* and a typo in it silently
 * renders a blank gap. A closed list turns "my status line shows nothing where
 * `modle` should be" into a validation error naming the offender.
 *
 * ## The context gauge has four modes, not two
 *
 * `off` is a solid line. `percentage` fills the used portion. `annotated` adds
 * ticks at the **speculative** and **auto-compaction** boundaries, which are the
 * two points where the next turn's behaviour changes and a user watching a
 * percentage cannot see coming. `embedded` puts the numbers in the gauge itself.
 *
 * The ticks are the whole reason `annotated` exists, and they are why the
 * percentage alone is not sufficient: at 70% the line looks the same whether the
 * next message compacts or not.
 *
 * ## Boundaries are computed, not hard-coded
 *
 * The speculative boundary is a fraction of the window, and the compaction
 * boundary is derived from what the session will actually compact at. A gauge
 * that marks a fixed 80% marks the wrong thing on a model with a different
 * compaction trigger, and the tick then lies.
 */

/** A segment the status line can show. */
export const STATUS_LINE_SEGMENT_IDS = [
	"pi",
	"status",
	"model",
	"mode",
	"path",
	"git",
	"pr",
	"subagents",
	"token_in",
	"token_out",
	"token_total",
	"token_rate",
	"cost",
	"context_pct",
	"context_total",
	"time_spent",
	"time",
	"session",
	"hostname",
	"cache_read",
	"cache_write",
	"cache_hit",
	"session_name",
	"usage",
	"collab",
	"stream",
	"vim",
] as const;

export type StatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];

export function isStatusLineSegmentId(value: string): value is StatusLineSegmentId {
	return (STATUS_LINE_SEGMENT_IDS as readonly string[]).includes(value);
}

/** The baseline a custom line starts from. */
export const CUSTOM_STATUS_LINE_DEFAULTS: {
	readonly left: StatusLineSegmentId[];
	readonly right: StatusLineSegmentId[];
} = {
	left: ["vim", "model", "mode", "path", "git", "pr"],
	right: ["session_name", "token_total", "cost", "context_pct"],
};

export type ContextLineMode = "off" | "percentage" | "annotated" | "embedded";

export const CONTEXT_LINE_MODES: readonly ContextLineMode[] = ["off", "percentage", "annotated", "embedded"];

export type SegmentValidation =
	| { readonly ok: true; readonly left: StatusLineSegmentId[]; readonly right: StatusLineSegmentId[] }
	| { readonly ok: false; readonly unknown: readonly string[] };

/**
 * Validates a custom status line.
 *
 * Reports every unknown identifier rather than the first, because a hand-edited
 * line usually has the same mistake in two places and fixing them one run at a
 * time is the tedious version of this.
 */
export function validateSegments(input: { left: readonly string[]; right: readonly string[] }): SegmentValidation {
	const unknown: string[] = [];
	const check = (values: readonly string[]) => {
		for (const value of values) if (!isStatusLineSegmentId(value)) unknown.push(value);
	};
	check(input.left);
	check(input.right);
	if (unknown.length > 0) {
		// A typo in a custom status line otherwise renders as a blank gap with
		// nothing to explain it.
		return { ok: false, unknown };
	}
	return {
		ok: true,
		left: [...input.left] as StatusLineSegmentId[],
		right: [...input.right] as StatusLineSegmentId[],
	};
}

/** What the context gauge reports. */
export interface ContextUsage {
	/** Tokens currently in the context. */
	readonly used: number;
	/** The model's context window. */
	readonly window: number;
	/** Where speculative compaction would begin, as a fraction of the window. */
	readonly speculativeFraction?: number;
	/** The fraction at which the session compacts on its own. */
	readonly compactionFraction?: number;
}

/** The resolved gauge, with ticks placed as fractions. */
export interface ContextGauge {
	/** Used fraction, clamped to 0-1. */
	readonly used: number;
	/** Ticks, in ascending order, only when the mode annotates them. */
	readonly ticks: readonly { at: number; kind: "speculative" | "compaction" }[];
	readonly mode: ContextLineMode;
	/** The percentage as shown, rounded once here rather than at each render. */
	readonly percent: number;
}

const DEFAULT_SPECULATIVE_FRACTION = 0.8;
const DEFAULT_COMPACTION_FRACTION = 0.9;

/**
 * Resolves the gauge.
 *
 * The ticks are computed from the session's own boundaries rather than fixed
 * numbers, because a gauge marking a hard-coded 80% marks the wrong thing on a
 * model with a different trigger - and a tick that lies is worse than no tick.
 */
export function resolveContextGauge(mode: ContextLineMode, usage: ContextUsage): ContextGauge {
	// A window of zero would divide by zero and report a nonsensical percentage, so
	// an unconfigured model reads as empty rather than full.
	const window = usage.window > 0 ? usage.window : 0;
	const usedFraction = window === 0 ? 0 : Math.max(0, Math.min(1, usage.used / window));
	const percent = Math.round(usedFraction * 100);

	if (mode === "off" || mode === "percentage") {
		// No ticks: a solid or plain fill carries no boundary information, and drawing
		// ticks a user cannot see the effect of would be decoration.
		return { used: usedFraction, ticks: [], mode, percent };
	}

	const ticks: { at: number; kind: "speculative" | "compaction" }[] = [];
	const speculative = usage.speculativeFraction ?? DEFAULT_SPECULATIVE_FRACTION;
	const compaction = usage.compactionFraction ?? DEFAULT_COMPACTION_FRACTION;
	// Only a tick inside the window is drawable, and both are clamped: a fraction
	// beyond 1 would place a mark off the end of the gauge.
	if (speculative > 0 && speculative < 1) ticks.push({ at: speculative, kind: "speculative" });
	if (compaction > 0 && compaction < 1) ticks.push({ at: compaction, kind: "compaction" });
	// Ascending, so a renderer that walks the list does not have to sort.
	ticks.sort((left, right) => left.at - right.at);

	return { used: usedFraction, ticks, mode, percent };
}

/** Whether a mode shows the numbers, as opposed to only the fill. */
export function modeShowsNumbers(mode: ContextLineMode): boolean {
	return mode === "percentage" || mode === "annotated" || mode === "embedded";
}

/** One line for a settings hint, naming what the ticks mean. */
export function describeContextLine(mode: ContextLineMode): string {
	switch (mode) {
		case "off":
			return "A solid line, with no context feedback.";
		case "percentage":
			return "The used portion filled in the accent colour.";
		case "annotated":
			return "Filled, with ticks at the speculative and auto-compaction boundaries.";
		case "embedded":
			return "Filled, with the percentage and window written into the gauge itself.";
	}
}
