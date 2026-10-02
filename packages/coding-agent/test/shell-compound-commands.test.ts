import { describe, expect, it } from "vitest";
import {
	type ApprovalRule,
	decideChain,
	extractLiteralAndChainSegments,
	isPosixShell,
	matches,
} from "../src/core/shell/compound-commands.ts";

/**
 * Compound shell commands.
 *
 * The property that defines the whole design: **segmentation only happens for a
 * chain the tokenizer can read literally.** A segment it cannot account for
 * returns null for the *whole chain*, which then falls back to ordinary bash
 * approval. A refusal to segment is conservative; a wrong "safe" segmentation
 * is how a delete gets waved through.
 */

const CRITICAL = [/\brm\s+-rf\b/];

describe("literal chains split", () => {
	it("splits a && chain into its commands", () => {
		const segments = extractLiteralAndChainSegments("git status && npm test");
		expect(segments?.map((segment) => segment.argv[0])).toEqual(["git", "npm"]);
	});

	it("preserves quoted arguments as one token", () => {
		// A quoted separator is data, not a boundary: splitting on it would judge a
		// command the user never wrote. `grep` is deliberately avoided as the head,
		// because it is an interpreter wrapper and the chain is deliberately not
		// literal.
		const segments = extractLiteralAndChainSegments('make -f "a && b" && echo done');
		expect(segments?.[0]?.argv).toEqual(["make", "-f", "a && b"]);
		expect(segments?.[1]?.argv).toEqual(["echo", "done"]);
	});

	it("handles escaped characters inside quotes", () => {
		expect(extractLiteralAndChainSegments('echo "a\\"b" && ls')?.[0]?.argv).toEqual(["echo", 'a"b']);
	});

	it("returns nothing for an empty command", () => {
		expect(extractLiteralAndChainSegments("")).toBeNull();
	});

	it("recognises a single command", () => {
		expect(extractLiteralAndChainSegments("ls -la")?.map((segment) => segment.argv[0])).toEqual(["ls"]);
	});
});

describe("a non-literal chain is never segmented", () => {
	it("refuses a chain containing a control character", () => {
		// A newline says something about how the shell will read the string that
		// this tokenizer does not model.
		expect(extractLiteralAndChainSegments("ls && rm -rf /\nls")).toBeNull();
	});

	it("refuses a chain with a leading environment assignment", () => {
		expect(extractLiteralAndChainSegments("FOO=bar ls && ls")).toBeNull();
	});

	it("refuses a chain with a reinterpreting option", () => {
		// `sh -c` turns a literal-looking argument into arbitrary commands.
		expect(extractLiteralAndChainSegments("sh -c rm -rf /tmp && ls")).toBeNull();
	});

	it("refuses a chain with an interpreter wrapper", () => {
		expect(extractLiteralAndChainSegments("bash script.sh && ls")).toBeNull();
	});

	it("refuses a chain with a stateful command", () => {
		// `cd` changes what every later segment means, and this tokenizer does not
		// model the shell's working directory.
		expect(extractLiteralAndChainSegments("cd /tmp && ls")).toBeNull();
	});

	it("refuses an unterminated quote", () => {
		expect(extractLiteralAndChainSegments('echo "unterminated && ls')).toBeNull();
	});

	it("does not treat a single & as a separator", () => {
		// `&` backgrounds rather than sequences, so claiming to have judged it
		// would mean judging a command never seen.
		expect(extractLiteralAndChainSegments("ls & rm -rf /tmp")).toBeNull();
	});
});

describe("shell recognition", () => {
	it("accepts the posix shells where && is well defined", () => {
		expect(isPosixShell("/bin/bash")).toBe(true);
		expect(isPosixShell("zsh")).toBe(true);
		expect(isPosixShell("cmd.exe")).toBe(false);
		expect(isPosixShell("powershell")).toBe(false);
	});
});

describe("approval precedence", () => {
	const rules: ApprovalRule[] = [
		{ match: "git status", approval: "allow" },
		{ match: "rm *", approval: "deny" },
	];

	it("judges each segment on its own", () => {
		// Approving the chain as one string shows the user `git status` and hides
		// the delete behind it.
		const decision = decideChain({
			command: "git status && rm -rf /tmp/x",
			rules,
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("deny");
	});

	it("allows a chain when every segment is allowed", () => {
		const decision = decideChain({
			command: "git status && ls",
			// Two explicit globs rather than the regex alternation `^(git|ls)\b` this test
			// originally used. Under glob rules `()` is literal, so the alternation could
			// never have matched anything.
			rules: [
				{ match: "git status", approval: "allow" },
				{ match: "ls", approval: "allow" },
			],
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("allow");
	});

	it("prompts when a segment matches nothing", () => {
		const decision = decideChain({
			command: "git status && curl http://x",
			rules,
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("prompt");
	});

	it("keeps first-match ordering for a segment", () => {
		// A specific allow earlier in the list still wins for that segment.
		const decision = decideChain({
			command: "git status && ls",
			rules: [
				{ match: "git status", approval: "allow" },
				{ match: "ls", approval: "deny" },
			],
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("deny");
	});

	it("stops on a whole-chain deny before considering any segment", () => {
		const decision = decideChain({
			command: "git status && ls",
			// `*&&*`, not `&&`: patterns are globs anchored to the whole command, so a bare
			// `&&` can only ever match a command that is exactly "&&" and would never fire.
			// The property under test is that a chainOnly deny is evaluated against the
			// whole chain before any segment is judged.
			rules: [{ match: "*&&*", approval: "deny", chainOnly: true }],
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("deny");
	});

	it("treats the chain as one opaque command when compound is off", () => {
		// The safe default: a setting that is off does not mean "assume it was safe".
		const decision = decideChain({
			command: "git status && rm -rf /tmp/x",
			rules,
			compoundAllowed: false,
			shell: "bash",
		});
		expect(decision.kind).toBe("prompt");
	});

	it("treats the chain as opaque when the shell is not posix", () => {
		expect(decideChain({ command: "ls && ls", rules, compoundAllowed: true, shell: "cmd.exe" }).kind).toBe("prompt");
	});

	it("treats the chain as opaque when segmentation fails", () => {
		// `cd` changes what every later segment means, so the chain is refused
		// segmentation. An allow-all rule set must then still prompt: without the
		// segmentation refusal this would be allowed outright.
		const decision = decideChain({
			command: "cd /tmp && ls",
			rules: [{ match: "*", approval: "allow" }],
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("prompt");
	});
});

describe("critical patterns", () => {
	it("escalates a critical pattern in a segment", () => {
		const decision = decideChain({
			command: "ls && rm -rf /tmp/x",
			rules: [{ match: "*", approval: "allow" }],
			compoundAllowed: true,
			shell: "bash",
			criticalPatterns: CRITICAL,
		});
		expect(decision.kind).toBe("escalate");
	});

	it("escalates a critical pattern on an unsegmented command", () => {
		const decision = decideChain({
			command: "rm -rf /tmp/x",
			rules: [{ match: "*", approval: "allow" }],
			compoundAllowed: false,
			criticalPatterns: CRITICAL,
		});
		expect(decision.kind).toBe("escalate");
	});

	it("does not escalate when the pattern appears only in a segment's arguments", () => {
		const decision = decideChain({
			command: "echo rm && ls",
			rules: [{ match: "*", approval: "allow" }],
			compoundAllowed: true,
			shell: "bash",
			criticalPatterns: CRITICAL,
		});
		expect(decision.kind).toBe("allow");
	});
});

describe("a malformed rule must not silently allow", () => {
	it("matches a regex-looking pattern literally rather than as a regex", () => {
		// There is no "malformed" pattern to survive: `patternToRegExp` escapes every
		// metacharacter except `*`, so it cannot throw, and `([unclosed` is simply the
		// literal text "([unclosed". Confirmed against the reference
		// (oh-my-pi packages/coding-agent/src/tools/bash.ts:246-252), which applies the
		// identical transform.
		//
		// This test previously asserted the opposite - that such a pattern matches
		// everything - on the theory that a rule the user wrote must never be dropped.
		// That behaviour does not exist and never did, so the assertion could not pass.
		// The property that actually matters is the one below: a deny that does not
		// match leaves the segment unmatched, which prompts rather than allows.
		expect(matches({ match: "([unclosed", approval: "deny" }, "anything")).toBe(false);
		expect(matches({ match: "([unclosed", approval: "deny" }, "([unclosed")).toBe(true);
	});

	it("never allows a chain under a deny that does not match it", () => {
		const decision = decideChain({
			command: "ls",
			rules: [{ match: "([unclosed", approval: "deny" }],
			compoundAllowed: true,
			shell: "bash",
		});
		expect(decision.kind).toBe("prompt");
	});
});
