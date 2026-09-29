import { describe, expect, it } from "vitest";
import {
	allMatchingRules,
	commandMatches,
	describePatternRisk,
	firstMatchingRule,
	normalizePattern,
	parseApprovalPatterns,
	patternToRegExp,
} from "../src/core/shell/approval-patterns.ts";

/**
 * Bash approval patterns.
 *
 * Two properties define the design: a pattern is a **glob, not a regex** — only
 * `*` is a wildcard and every metacharacter is escaped — and matching is
 * **anchored at both ends**, so `npm test` cannot quietly cover
 * `npm test && rm -rf /`.
 */

describe("a pattern is a glob, not a regular expression", () => {
	it("treats * as a wildcard", () => {
		expect(commandMatches("npm test --watch", "npm test*")).toBe(true);
		expect(commandMatches("git status", "npm *")).toBe(false);
	});

	it("escapes regex metacharacters rather than honouring them", () => {
		// A user who believes the pattern language is regex is mistaken, and
		// `rm -rf /tmp/*` meaning "a character class" is not a subtle difference.
		expect(commandMatches("ls", "ls|rm")).toBe(false);
		expect(commandMatches("a.c", "a.c")).toBe(true);
		// A literal dot does not match an arbitrary character.
		expect(commandMatches("abc", "a.c")).toBe(false);
		expect(commandMatches("a+c", "a+c")).toBe(true);
		expect(commandMatches("abbbc", "a+c")).toBe(false);
	});

	it("escapes parentheses rather than treating them as a group", () => {
		expect(commandMatches("(ls)", "(ls)")).toBe(true);
		expect(commandMatches("ls", "(ls)")).toBe(false);
	});

	it("matches nothing for an empty command", () => {
		expect(commandMatches("   ", "*")).toBe(false);
	});
});

describe("matching is anchored at both ends", () => {
	it("does not match a command that merely contains the pattern", () => {
		// The mistake per-segment matching exists to prevent.
		expect(commandMatches("echo hi && npm test", "npm test")).toBe(false);
		expect(commandMatches("npm test && rm -rf /", "npm test")).toBe(false);
	});

	it("matches the whole command exactly", () => {
		expect(commandMatches("npm test", "npm test")).toBe(true);
		expect(commandMatches("npm test --watch", "npm test")).toBe(false);
	});

	it("an unanchored-looking pattern still needs the full command", () => {
		const source = patternToRegExp("npm test").source;
		expect(source.startsWith("^")).toBe(true);
		expect(source.endsWith("$")).toBe(true);
	});
});

describe("whitespace is normalised on both sides", () => {
	it("collapses runs and trims", () => {
		expect(normalizePattern("  git   status  ")).toBe("git status");
	});

	it("matches a pattern written readably", () => {
		// Without normalisation a user writing `git  status` finds it never matches,
		// and the safe response to a pattern that never fires is to widen it.
		expect(commandMatches("git status", "git  status")).toBe(true);
	});
});

describe("ordered rules", () => {
	const rules = [
		{ match: "git status", approval: "allow" as const },
		{ match: "rm *", approval: "deny" as const },
		{ match: "npm *", approval: "prompt" as const },
	];

	it("takes the first match, in order", () => {
		expect(firstMatchingRule("git status", rules)?.approval).toBe("allow");
		expect(firstMatchingRule("rm -rf /tmp", rules)?.approval).toBe("deny");
		expect(firstMatchingRule("npm test", rules)?.approval).toBe("prompt");
	});

	it("returns nothing when no rule matches", () => {
		expect(firstMatchingRule("cargo build", rules)).toBeUndefined();
	});

	it("reports every match, not just the first", () => {
		// An aggregate view is what a chain decision needs, because a later deny
		// outranks an earlier allow.
		expect(allMatchingRules("npm test", rules)).toHaveLength(1);
	});

	it("excludes chain-only rules from per-command matching", () => {
		const withChain = [...rules, { match: "&&", approval: "deny" as const, chainOnly: true }];
		expect(firstMatchingRule("git status", withChain)?.match).toBe("git status");
	});
});

describe("parsing the setting", () => {
	it("accepts well-formed entries", () => {
		expect(
			parseApprovalPatterns([
				{ match: "git status", approval: "allow" },
				{ match: "rm *", approval: "deny", chainOnly: true },
			]),
		).toEqual([
			{ match: "git status", approval: "allow" },
			{ match: "rm *", approval: "deny", chainOnly: true },
		]);
	});

	it("drops a malformed entry rather than failing the list", () => {
		// One bad rule silently disabling every rule around it is far worse than a
		// missing restriction the user can see is missing.
		const parsed = parseApprovalPatterns([
			{ match: "git status", approval: "allow" },
			{ match: "rm *", approval: "sometimes" },
			{ approval: "deny" },
			{ match: "  ", approval: "deny" },
			"not an object",
		]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.match).toBe("git status");
	});

	it("returns nothing for a non-array", () => {
		expect(parseApprovalPatterns("git status")).toEqual([]);
		expect(parseApprovalPatterns(undefined)).toEqual([]);
	});
});

describe("a pattern that is broader than it reads is called out", () => {
	it("calls a catch-all out", () => {
		expect(describePatternRisk("*")).toBe("catch-all");
	});

	it("calls a leading or trailing wildcard broad", () => {
		expect(describePatternRisk("*rm -rf*")).toBe("broad");
		expect(describePatternRisk("npm test*")).toBe("broad");
	});

	it("calls an exact pattern narrow", () => {
		expect(describePatternRisk("git status")).toBe("narrow");
		expect(describePatternRisk("npm test --coverage")).toBe("narrow");
	});
});
