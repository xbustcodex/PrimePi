/**
 * Thinking-effort vocabulary, and how it maps onto Prime Pi's reasoning levels.
 *
 * Ported from the reference's `packages/catalog/src/effort.ts` and `model-thinking.ts`, with one
 * deliberate difference. The reference replaced string thinking levels with an `Effort` enum and
 * made `getSupportedEfforts` read `model.thinking.efforts`. Prime Pi's models declare reasoning
 * through `model.reasoning` and budgets through `thinkingBudgets` - the level itself is the
 * authority, and a model names the levels it accepts there.
 *
 * Rather than introduce a parallel enum that no provider populates, the enum is kept as the
 * *naming* vocabulary the settings surface presents, and every function here translates between
 * it and Prime Pi's own `ThinkingLevel`. That keeps the reference's user-facing vocabulary and
 * its clamp semantics without a second source of truth about what a model supports.
 */

/** User-facing thinking levels, ordered least to most intensive. */
export const Effort = {
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
} as const;

export type Effort = (typeof Effort)[keyof typeof Effort];

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

/**
 * Prime Pi's thinking levels, in the same order as {@link THINKING_EFFORTS}.
 *
 * `off` is absent deliberately: it is an instruction to disable reasoning, not a level of it,
 * so it has no counterpart among the efforts.
 */
const LEVEL_TO_EFFORT: Readonly<Record<string, Effort>> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

const EFFORT_TO_LEVEL: Readonly<Record<Effort, string>> = {
	[Effort.Minimal]: "minimal",
	[Effort.Low]: "low",
	[Effort.Medium]: "medium",
	[Effort.High]: "high",
	[Effort.XHigh]: "xhigh",
	[Effort.Max]: "max",
};

/** The effort a Prime Pi thinking level presents as, or `undefined` if it has no counterpart. */
export function effortForLevel(level: string | undefined): Effort | undefined {
	return level === undefined ? undefined : LEVEL_TO_EFFORT[level];
}

/** The Prime Pi thinking level an effort corresponds to. */
export function levelForEffort(effort: Effort): string {
	return EFFORT_TO_LEVEL[effort];
}

/**
 * The minimum shape the clamping helpers need from a model.
 *
 * `reasoning` is the level the model reports, or a boolean when the catalog only says whether
 * the model reasons at all. Both are accepted because Prime Pi's catalog carries a level and the
 * reference's carried a flag, and a caller should not have to know which it is holding.
 */
export interface ReasoningModelLike {
	reasoning?: string | boolean;
	/** Present on models that name the levels they accept. */
	thinking?: { efforts?: readonly Effort[] } | undefined;
}

/**
 * The efforts a model accepts.
 *
 * A model that does not reason supports none. Otherwise, when the model names them, its own
 * list is authoritative; when it does not, every effort is offered, because a model that
 * declares reasoning without enumerating levels is not saying it refuses any of them.
 */
export function getSupportedEfforts(model: ReasoningModelLike): readonly Effort[] {
	if (!model.reasoning) return [];
	const declared = model.thinking?.efforts;
	if (declared && declared.length > 0) return declared;
	return THINKING_EFFORTS;
}

/**
 * Clamp a requested level against what the model actually supports.
 *
 * A non-reasoning model resolves to `undefined` - the request layer sends no reasoning
 * parameter at all, which is not the same as sending "off".
 *
 * When the model enumerates its levels and the request is above the highest, it is lowered
 * rather than refused: a user asking for maximum reasoning on a model that tops out at high
 * should get high, not an error.
 */
export function clampThinkingLevelForModel(
	model: ReasoningModelLike | undefined,
	requested: string | undefined,
): string | undefined {
	if (!model?.reasoning) return undefined;
	if (requested === undefined) return undefined;
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return requested;

	const requestedEffort = effortForLevel(requested);
	// An unrecognised level is passed through: clamping to a level the model never declared
	// would silently change what the user asked for.
	if (requestedEffort === undefined) return requested;

	const highest = supported[supported.length - 1]!;
	if (THINKING_EFFORTS.indexOf(requestedEffort) > THINKING_EFFORTS.indexOf(highest)) {
		return levelForEffort(highest);
	}
	const lowest = supported[0]!;
	if (THINKING_EFFORTS.indexOf(requestedEffort) < THINKING_EFFORTS.indexOf(lowest)) {
		return levelForEffort(lowest);
	}
	return requested;
}
/**
 * A thinking level as configured, including the `auto` sentinel.
 *
 * `off` and `inherit` are settings-only - neither is an effort - and `auto` defers to the
 * model's own default. All four are spelled here rather than widening to `string`, so a
 * configured-level parameter is actually checked.
 */
export type ConfiguredThinkingLevel = ConfiguredLevel | "auto";

/**
 * The configured thinking level, including the two settings-only members.
 *
 * The reference declares this as an enum with `Inherit` and `Off` alongside the six efforts.
 * Prime Pi's `ThinkingLevel` is a bare string union of the six efforts - it names what a *model*
 * reports, not what a *setting* may hold - so the configured vocabulary is declared here.
 */
export const ConfiguredLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
} as const;

export type ConfiguredLevel = (typeof ConfiguredLevel)[keyof typeof ConfiguredLevel];
