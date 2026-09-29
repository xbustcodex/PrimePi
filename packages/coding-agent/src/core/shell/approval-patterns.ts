/**
 * Bash approval patterns: the ordered rules that decide what a command needs.
 *
 * ## What a pattern is, and what it deliberately is not
 *
 * A pattern is a **glob, not a regular expression.** Only `*` is a wildcard;
 * every regex metacharacter is escaped. The setting says so, and it matters:
 * a pattern language users believe is regex is a pattern language that behaves
 * differently, and `rm -rf /tmp/*` meaning "anything ending in a character
 * class" is not a subtle difference.
 *
 * ## Anchoring is the whole safety property
 *
 * Patterns match the **entire** command, anchored at both ends. An unanchored
 * `npm test` would also match `npm test && rm -rf /`, which is precisely the
 * mistake per-segment matching exists to prevent. Anchoring means a pattern
 * describes the whole of what it matches, so `git status` cannot quietly cover a
 * compound line.
 *
 * ## Whitespace is normalised on both sides
 *
 * Runs of whitespace collapse to one space and the ends are trimmed, so a
 * pattern written as `git  status` matches a command written as `git status`.
 * Without that, a user writing a readable pattern would find it never matches,
 * and the safe response to a pattern that never fires is to widen it - which is
 * how a dangerous allow gets written.
 */

/** What a pattern's verdict is. */
export type PatternApproval = "allow" | "deny" | "prompt";

/** One rule. */
export interface ApprovalPattern {
	/** A glob, where only `*` is a wildcard. */
	readonly match: string;
	readonly approval: PatternApproval;
	/** When set, the rule applies only to the complete chain, not per segment. */
	readonly chainOnly?: boolean;
}

/** Collapses whitespace so a pattern and a command are compared the same way. */
export function normalizePattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

/**
 * Converts a glob to an anchored regular expression.
 *
 * Only `*` survives as a wildcard. Everything else - including `.`, `+`, `?`,
 * `(`, `)`, `[`, `]`, `{`, `}`, `^`, `$` and `|` - is escaped, so a pattern
 * cannot smuggle in regex behaviour the user was not told about.
 */
export function patternToRegExp(pattern: string): RegExp {
	const escaped = normalizePattern(pattern)
		.split("*")
		.map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

/** Whether a command matches a pattern, anchored and whitespace-normalised. */
export function commandMatches(command: string, pattern: string): boolean {
	const normalized = normalizePattern(command);
	if (normalized.length === 0) return false;
	return patternToRegExp(pattern).test(normalized);
}

/** The first rule matching a command, in order. */
export function firstMatchingRule(command: string, rules: readonly ApprovalPattern[]): ApprovalPattern | undefined {
	return rules.find((rule) => !rule.chainOnly && commandMatches(command, rule.match));
}

/** Every rule matching a command, in order. */
export function allMatchingRules(command: string, rules: readonly ApprovalPattern[]): ApprovalPattern[] {
	return rules.filter((rule) => !rule.chainOnly && commandMatches(command, rule.match));
}

/**
 * Parses the setting's wire form.
 *
 * Malformed entries are dropped rather than failing the whole list: one bad rule
 * should not silently disable the rules around it, which is a far worse
 * outcome than a missing restriction the user can see is missing.
 */
export function parseApprovalPatterns(raw: unknown): ApprovalPattern[] {
	if (!Array.isArray(raw)) return [];
	const out: ApprovalPattern[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { match?: unknown; approval?: unknown; chainOnly?: unknown };
		if (typeof record.match !== "string" || record.match.trim().length === 0) continue;
		if (record.approval !== "allow" && record.approval !== "deny" && record.approval !== "prompt") {
			continue;
		}
		out.push({
			match: record.match,
			approval: record.approval,
			...(record.chainOnly === true ? { chainOnly: true } : {}),
		});
	}
	return out;
}

/**
 * Validates a pattern, for a settings panel.
 *
 * A pattern is always *usable* as a glob, so this reports whether it does what
 * the user probably meant rather than whether it compiles: an unanchored-looking
 * pattern, or one whose only wildcard is a leading `*`, matches far more than it
 * reads like it does.
 */
export function describePatternRisk(pattern: string): "narrow" | "broad" | "catch-all" {
	const normalized = normalizePattern(pattern);
	if (normalized === "*" || normalized === "* *") return "catch-all";
	// A leading or trailing wildcard makes the rule match a whole class of
	// commands rather than one, which is worth saying out loud.
	if (normalized.startsWith("*") || normalized.endsWith("*")) return "broad";
	return "narrow";
}
