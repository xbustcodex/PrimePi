/**
 * The thinking-level vocabulary, as a leaf.
 *
 * This is a module with no imports at all, and that is the whole point. The list
 * used to live in `model-roles.ts`, which imports `failover.ts` and `free-model.ts`
 * and therefore drags `models.ts` in with it. `thinking-level.ts` needed exactly two
 * things from it — the list and a type guard — and paid for that with a `./utils/*`
 * entry point reaching 17 files against a budget of 3.
 *
 * Vocabulary shared by modules that must stay independent of each other belongs in
 * a leaf, not in whichever module happened to need it first. The alternative —
 * widening the budget — would have hidden a real coupling behind a raised limit.
 *
 * Mirrors `ThinkingLevel` in `@earendil-works/pi-agent-core`, redeclared here to
 * keep this module free of an agent-core dependency: `pi-ai` sits below that
 * package in the dependency graph.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RoleThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Whether a string names a thinking level Pi supports. */
export function isThinkingLevel(value: string): value is RoleThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}
