import { describe, expect, it } from "vitest";
import { commandMatches } from "../src/core/shell/approval-patterns.ts";
import { decideChain, matches } from "../src/core/shell/compound-commands.ts";

/**
 * The two pattern matchers must agree.
 *
 * ## The defect this pins
 *
 * `compound-commands.matches` compiled the rule's pattern directly as a regular
 * expression while `approval-patterns.commandMatches` treated it as an anchored
 * glob with only `*` as a wildcard. Two settings-facing entry points therefore
 * implemented the same documented pattern language differently, and the shell
 * approval authority used the wrong one.
 *
 * `\ *` is a regex quantifier, so `rm *` meant "rm followed by zero or more
 * spaces" — matching any command *containing* those letters:
 *
 *     "rm *" vs "charm setup"      -> matched (regex)
 *     "rm *" vs "confirm --force"  -> matched (regex)
 *     "npm run *" vs "npm runbuild" -> matched (regex)
 *     "git status" vs "git   status" -> did not match (regex)
 *
 * A user writing `rm *` to refuse deletes would instead refuse `charm setup`,
 * while a deny rule for `git status` would miss the spaced spelling. Neither is
 * subtle, and both are the wrong direction: one over-refuses and one
 * under-refuses a rule the user wrote deliberately.
 */

const deny = (match: string) => ({ match, approval: "deny" as const });

describe("a pattern is a glob, not a regular expression", () => {
	it("does not treat * as a regex quantifier", () => {
		// The specific way the old matcher over-refused.
		expect(matches(deny("rm *"), "charm setup")).toBe(false);
		expect(matches(deny("rm *"), "confirm --force")).toBe(false);
		expect(matches(deny("npm run *"), "npm runbuild")).toBe(false);
	});

	it("still treats * as a wildcard", () => {
		// Otherwise the fix would have made every pattern literal.
		expect(matches(deny("rm *"), "rm -rf /tmp")).toBe(true);
		expect(matches(deny("npm run *"), "npm run test")).toBe(true);
	});

	it("escapes regex metacharacters in a pattern", () => {
		// A pattern language the user believes is regex behaves differently, which is
		// its own hazard.
		expect(matches(deny("a.c"), "abc")).toBe(false);
		expect(matches(deny("a.c"), "a.c")).toBe(true);
		expect(matches(deny("foo|bar"), "foo")).toBe(false);
		expect(matches(deny("x+y"), "xxyy")).toBe(false);
	});

	it("anchors at both ends", () => {
		// An unanchored `npm test` would also cover `npm test && rm -rf /`.
		expect(matches(deny("npm test"), "echo npm test")).toBe(false);
		expect(matches(deny("npm test"), "npm test && rm -rf /")).toBe(false);
	});

	it("agrees with the glob matcher on every case", () => {
		// Two entry points implementing one documented language must not diverge.
		const cases: [pattern: string, command: string][] = [
			["rm *", "echo rm -rf /tmp/abc"],
			["rm *", "charm setup"],
			["rm *", "confirm --force"],
			["git status", "git   status"],
			["git status", "git status"],
			["npm run *", "npm runbuild"],
			["npm run *", "npm run build"],
			["a.c", "abc"],
			["a.c", "a.c"],
			["*", "anything at all"],
		];
		for (const [pattern, command] of cases) {
			expect(matches({ match: pattern, approval: "allow" }, command), `${pattern} vs ${command}`).toBe(
				commandMatches(command, pattern),
			);
		}
	});
});

describe("degenerate patterns", () => {
	it("treats * as a real catch-all", () => {
		expect(matches({ match: "*", approval: "allow" }, "anything")).toBe(true);
	});

	it("matches nothing for an empty pattern", () => {
		// A rule with no text is a mistake, and reading it as a catch-all is the
		// unsafe direction: it would refuse every command.
		expect(matches({ match: "", approval: "deny" }, "ls")).toBe(false);
		expect(matches({ match: "   ", approval: "deny" }, "ls")).toBe(false);
	});

	it("does not throw on a pattern full of metacharacters", () => {
		// The old matcher caught a compile failure and returned true, which silently
		// refused everything a malformed pattern touched.
		expect(() => matches(deny("([unclosed"), "ls")).not.toThrow();
	});
});

describe("the fixed matcher decides chains by the glob reading", () => {
	it("refuses a real rm and not a lookalike", () => {
		const decide = (command: string) =>
			decideChain({ command, rules: [deny("rm *")], compoundAllowed: false, shell: "/bin/bash" });
		expect(decide("rm -rf /tmp/build").kind).toBe("deny");
		expect(decide("charm setup").kind).not.toBe("deny");
	});

	it("still denies a whole chain through a chainOnly rule", () => {
		const decision = decideChain({
			command: "git status && rm -rf /tmp/build",
			rules: [{ match: "*rm*", approval: "deny", chainOnly: true }],
			compoundAllowed: false,
			shell: "/bin/bash",
		});
		expect(decision.kind).toBe("deny");
	});
});
