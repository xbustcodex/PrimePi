/**
 * Thinking level: parsing, resolution and clamping.
 *
 * ## Three distinct things, often confused
 *
 * **Configured** is what the user asked for: a setting, a CLI flag, or a model
 * role's value. It may be a level, `auto`, or absent.
 *
 * **Concrete** is the configured value with `auto` removed. `auto` is not a
 * level — it means "let the model or role decide" — so it resolves to
 * `undefined`, which the request layer treats as "send no reasoning parameter".
 *
 * **Resolved** is the concrete value clamped to what the *current* model
 * actually supports. This is the only one that goes on the wire.
 *
 * Collapsing them is how a user sets `max` on a model that caps at `high` and
 * gets a request the provider rejects, or sets `auto` and has it sent literally.
 *
 * ## Clamping goes down, not up
 *
 * A requested level the model does not support is clamped to the highest level
 * it *does* support below the request. A model that supports `minimal` and
 * `high` asked for `max` resolves to `high`, never to a level above the request.
 *
 * If the model supports nothing below the request, the result is the model's
 * lowest supported level rather than `undefined`: a model that can reason at
 * all should reason, and silently dropping the request to "no reasoning" would
 * be a larger change than the user asked for.
 *
 * ## `off` is preserved explicitly
 *
 * `off` is not a low level — it is an instruction to disable reasoning
 * provider-side, and it is a legitimate choice. It survives resolution rather
 * than being clamped to the model's lowest reasoning level.
 */

// `getSupportedThinkingLevels` is declared below in this file. It used to be
// imported from `models.ts`, which is now a re-export of this module — importing it
// back would be a cycle, and `models.ts` reaches auth, providers and the transcript.
import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "../types.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./thinking-level-vocab.ts";

export { isThinkingLevel, THINKING_LEVELS };

/**
 * The levels a model will accept, most to least reasoning.
 *
 * `xhigh` and `max` are opt-in per model: absent from `thinkingLevelMap` means the
 * provider does not offer them, so they must not be requested on the strength of
 * `reasoning: true` alone. An explicit `null` is a provider saying "this level is
 * not available for this model", which is stronger than absence.
 *
 * Lives here rather than in `models.ts` so that this module stays a leaf over the
 * model vocabulary. `models.ts` reaches auth, providers and the transcript, and a
 * `./utils/*` entry point that pulls it in breaches the entry-graph budget.
 */
const EXTENDED_THINKING_LEVELS = THINKING_LEVELS;

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * Clamps a requested level to the nearest one the model actually supports.
 *
 * Prefers clamping down, then falls back up: a model that supports nothing below
 * the request resolves to its lowest supported level rather than refusing, because a
 * model that can reason at all should reason.
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/** The sentinel meaning "use the model's or role's own value". */
export const AUTO_THINKING = "auto";

/** The sentinel meaning "inherit the session default". */
export const INHERIT_THINKING = "inherit";

/** What a configured setting or flag may carry. */
export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING | typeof INHERIT_THINKING | "off";

/**
 * Resolves a map entry, accepting unambiguous abbreviations.
 *
 * `xhi` resolves to `xhigh` and `med` to `medium`, so every selector surface
 * parses alike. A two-character minimum keeps a single letter from guessing:
 * `m` is ambiguous across `medium`, `minimal` and `max`, and a wrong guess here
 * silently changes how hard the model thinks.
 */
function resolveSelector<T extends string>(selectors: readonly T[], value: string | null | undefined): T | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = value.trim().toLowerCase();
	if (trimmed.length === 0) return undefined;
	if ((selectors as readonly string[]).includes(trimmed)) return trimmed as T;
	if (trimmed.length < 2) return undefined;
	const matches = selectors.filter((selector) => selector.startsWith(trimmed));
	return matches.length === 1 ? matches[0] : undefined;
}

/** Parses a thinking level, accepting unambiguous abbreviations. */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	// The shared list also carries `off`, which is a configured value rather than a
	// level, so it is filtered here rather than duplicated.
	const level = resolveSelector(THINKING_LEVELS, value);
	return level === "off" || level === undefined ? undefined : level;
}

/** Parses a configured value, which may also be `auto`, `inherit` or `off`. */
export function parseConfiguredThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === AUTO_THINKING || trimmed === INHERIT_THINKING || trimmed === "off") return trimmed;
	return parseThinkingLevel(trimmed);
}

/**
 * Removes `auto` and `inherit` from a configured value.
 *
 * Both mean "someone else decides", and the request layer expresses that as
 * `undefined` — not by sending the literal string to a provider.
 */
export function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	if (level === undefined || level === AUTO_THINKING || level === INHERIT_THINKING) return undefined;
	if (level === "off") return undefined;
	// Narrowed from the configured union; the sentinels and `off` returned above.
	return level as ThinkingLevel;
}

/** True when the value explicitly asks for provider-side reasoning to be disabled. */
export function shouldDisableReasoning(level: ConfiguredThinkingLevel | undefined): boolean {
	return level === "off";
}

/** The levels a model supports, in ascending order. */
export function supportedThinkingLevels<TApi extends Api>(
	model: Model<TApi> | undefined,
): readonly ModelThinkingLevel[] {
	if (!model) return [];
	return getSupportedThinkingLevels(model);
}

/**
 * Clamps a requested level against what the model supports.
 *
 * Clamps **down**: the result never exceeds the request. A model that supports
 * nothing below the request resolves to the model's lowest level, because a
 * model that can reason at all should reason.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: Model<TApi> | undefined,
	requested: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	// No model means nothing to clamp against; the caller decides.
	if (!model) return requested;
	// A non-reasoning model resolves to nothing rather than to a level it will
	// reject.
	if (!model.reasoning || requested === undefined) return undefined;

	const levels = getSupportedThinkingLevels(model);
	if (levels.includes(requested)) return requested;

	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	if (requestedIndex === -1) return undefined;

	// Walk the model's own levels and keep the last one below the request.
	let clamped: ThinkingLevel | undefined;
	for (const level of levels) {
		if (level === "off") continue;
		if (THINKING_LEVELS.indexOf(level as ThinkingLevel) > requestedIndex) break;
		clamped = level as ThinkingLevel;
	}
	// Nothing below the request: use the model's lowest, not nothing. Silently
	// dropping to "no reasoning" would be a larger change than the user asked.
	return clamped ?? (levels.find((level) => level !== "off") as ThinkingLevel | undefined);
}

/**
 * Resolves a configured value against the current model, preserving `off`.
 *
 * The one entry point a session should use: it takes what the user configured
 * and produces what goes on the wire, without the caller having to remember
 * which of the three representations applies.
 */
export function resolveThinkingLevelForModel<TApi extends Api>(
	model: Model<TApi> | undefined,
	configured: ConfiguredThinkingLevel | undefined,
): ThinkingLevel | undefined {
	// `off` and `inherit` both mean "no reasoning parameter", and `off` is a
	// deliberate choice rather than an absence.
	if (configured === undefined || configured === INHERIT_THINKING) return undefined;
	if (configured === AUTO_THINKING) return undefined;
	if (configured === "off") return undefined;
	return clampThinkingLevelForModel(model, configured);
}
