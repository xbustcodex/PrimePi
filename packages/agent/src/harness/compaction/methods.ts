/**
 * Automatic context-maintenance methods and the default order they are tried in.
 *
 * The order is a **preference, not a requirement**: an unavailable or failed
 * method advances to the next. A maintenance method that cannot run must not
 * take the session down with it.
 *
 * Server-native compaction comes first because it is the only method that
 * reduces what the *provider* holds rather than what the client sends.
 *
 * `shake` sits above the summarising fallback because dropping recoverable
 * content costs nothing — no LLM call, no latency, no model that might
 * summarise badly. It is the right first *local* method and the wrong only
 * method.
 */

/** One selectable automatic context-maintenance method. */
export type CompactionMethod = "remote" | "snapcompact" | "handoff" | "soft" | "shake";

/** The choices a settings row presents, in the order they are explained. */
export const COMPACTION_METHOD_CHOICES: ReadonlyArray<{
	value: CompactionMethod;
	label: string;
	description: string;
}> = [
	{
		value: "remote",
		label: "Server compaction",
		description: "Provider-native server compaction when the active route supports it",
	},
	{
		value: "snapcompact",
		label: "Snapcompact",
		description: "Archive history onto dense bitmap images the active vision model reads back; no LLM call",
	},
	{
		value: "handoff",
		label: "Handoff",
		description: "Generate a handoff document and continue from it as the compaction summary",
	},
	{
		value: "soft",
		label: "Soft compaction",
		description: "Summarize in place with a compaction model without using server compaction",
	},
	{
		value: "shake",
		label: "Shake",
		description: "Drop recoverable heavy content in place without an LLM call",
	},
];

/**
 * The default order: server-native first, portable summary last.
 *
 * `shake` precedes `soft` because it is free and `soft` costs a model call, and
 * both precede the summarising fallbacks that rewrite history irreversibly.
 */
export const DEFAULT_COMPACTION_METHOD_ORDER: readonly CompactionMethod[] = [
	"remote",
	"snapcompact",
	"handoff",
	"shake",
	"soft",
];

/**
 * A method order with duplicates and unknown entries removed.
 *
 * A settings file is hand-edited, and a duplicated or misspelled entry would
 * otherwise make the walk attempt the same method twice or skip a step.
 */
export function normaliseMethodOrder(order: readonly string[]): CompactionMethod[] {
	const known = new Set(COMPACTION_METHOD_CHOICES.map((choice) => choice.value));
	const seen = new Set<CompactionMethod>();
	const result: CompactionMethod[] = [];
	for (const entry of order) {
		if (!known.has(entry as CompactionMethod) || seen.has(entry as CompactionMethod)) continue;
		seen.add(entry as CompactionMethod);
		result.push(entry as CompactionMethod);
	}
	// A hand-edited order that dropped every known method leaves nothing to try,
	// so the default is restored rather than running no maintenance at all.
	return result.length > 0 ? result : [...DEFAULT_COMPACTION_METHOD_ORDER];
}
