import { commandMatches } from "./approval-patterns.ts";

/**
 * Compound shell commands: what a `&&` chain actually asks for, and how approval
 * decides on it.
 *
 * ## The problem
 *
 * `git status && rm -rf /tmp/build` is two commands. Approving it as one string
 * means the approval dialog shows the first and hides the second, which is the
 * shape of a confused-deputy bug: the user approves a read and a delete runs.
 *
 * So when compound commands are allowed, the chain is split and **each segment
 * is judged on its own**.
 *
 * ## The "literal" qualifier, and why it is the whole safety property
 *
 * Segmentation only happens for a chain the tokenizer can read *literally*:
 * no control characters, no expansions, no reinterpreting options, no
 * stateful commands, no interpreter wrappers.
 *
 * That is deliberately conservative. A segment the tokenizer cannot account for
 * returns `null` for the **whole chain**, and the chain then falls back to
 * ordinary bash approval — which treats it as one opaque command and asks the
 * user. A wrong "safe" segmentation is how a delete gets waved through; a
 * refusal to segment is merely conservative.
 *
 * ## First-match ordering, with deny outranking
 *
 * Segment rules keep their ordered first-match semantics, so a specific allow
 * earlier in the list still wins for that segment. Restrictions that match only
 * the **complete chain** are aggregated separately, and the scan continues past
 * a prompt: any later deny takes precedence, because a deny anywhere in a chain
 * must stop the chain.
 *
 * ## A critical pattern is not softened by segmentation
 *
 * A command matching a critical pattern is escalated. When the chain can be
 * segmented, the check runs per segment instead — a critical pattern anywhere in
 * the chain still escalates, but one that appears only in the *text* of a
 * segment that is not itself a command does not.
 */

/** One command in a chain. */
export interface ShellSegment {
	/** The command text, without the `&&` separators. */
	readonly text: string;
	/** Its argv, which is what a pattern rule matches against. */
	readonly argv: readonly string[];
	/** Where it starts in the original string. */
	readonly start: number;
}

/** Characters that make a string unreadable as a literal command list. */
const CONTROL_CHARACTERS = /[\x00-\x08\x09\x0a-\x1f\x7f]/;

/** A leading `VAR=value` assignment, which changes the environment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Options that make a program reinterpret its own arguments.
 *
 * `sh -c`, `eval`, `xargs`: each can turn a literal-looking argument into
 * arbitrary commands, so a chain containing one is not literal.
 */
const REINTERPRET_OPTION =
	/^-[^-].*[ce]$|^--(?:command|eval)$|^(?:eval|exec|source|\.|bash|sh|zsh|fish|ksh|csh|tcsh|dash|env|timeout|nohup|sudo|su|doas|xargs|find|awk|sed|perl|python|node|ruby|php|osascript|cmd|powershell|pwsh)(?:\s|$)/;

/** Commands whose effect depends on shell state we cannot see. */
const STATEFUL = new Set([
	"cd",
	"pushd",
	"popd",
	"umask",
	"trap",
	"export",
	"set",
	"unset",
	"alias",
	"unalias",
	"source",
]);

/** POSIX shells, which is where `&&` chaining is well defined. */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

/** Whether a configured shell interprets `&&` the way this module assumes. */
export function isPosixShell(shell: string): boolean {
	const name = shell.trim().toLowerCase();
	const base = name.split(/[/\\]/).pop() ?? name;
	return POSIX_SHELLS.has(base);
}

/**
 * Splits a chain into literal segments, or returns `null` when it cannot.
 *
 * `null` means "treat this as one opaque command", which is the safe outcome.
 */
export function extractLiteralAndChainSegments(command: string): ShellSegment[] | null {
	// Any control character except tab means the string is not a literal command list.
	// A newline in particular starts a *new command*, which is exactly the kind of
	// thing a segmented approval cannot see.
	if (CONTROL_CHARACTERS.test(command)) return null;

	const segments: ShellSegment[] = [];
	let argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let segmentStart = 0;
	let index = 0;

	const pushToken = () => {
		if (!tokenStarted) return;
		argv.push(token);
		token = "";
		tokenStarted = false;
	};

	const pushSegment = (end: number): boolean => {
		pushToken();
		if (argv.length === 0) return false;
		const executable = argv[0]!;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		// An assignment, a reinterpreting option, a stateful command or an
		// interpreter wrapper all make the segment non-literal, and a non-literal
		// segment makes the *chain* non-literal.
		if (argv.some((argument) => ASSIGNMENT.test(argument))) return false;
		if (argv.some((argument, position) => position > 0 && REINTERPRET_OPTION.test(argument))) return false;
		if (STATEFUL.has(commandName)) return false;
		if (REINTERPRET_OPTION.test(`${commandName} `)) return false;
		segments.push({ text: command.slice(segmentStart, end).trim(), argv, start: segmentStart });
		argv = [];
		return true;
	};

	while (index < command.length) {
		const char = command[index]!;
		if (quote) {
			if (char === "\\" && quote === '"' && index + 1 < command.length) {
				token += command[index + 1];
				tokenStarted = true;
				index += 2;
				continue;
			}
			if (char === quote) quote = undefined;
			else token += char;
			tokenStarted = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			index += 1;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			token += command[index + 1];
			tokenStarted = true;
			index += 2;
			continue;
		}
		if (/\s/.test(char)) {
			pushToken();
			index += 1;
			continue;
		}
		// `&&` splits the chain. A single `&` does not: it backgrounds rather than
		// sequences, and treating it as a separator would claim to have judged a
		// command it never saw.
		// Outside a quote only: `grep -r "a && b" .` contains the separator as data,
		// and splitting on it would judge a command the user never wrote.
		if (char === "&" && !quote) {
			if (command[index + 1] !== "&") {
				// A single `&` backgrounds rather than sequences, and its trailing command
				// runs concurrently. Judging the pair as if they were sequenced would be
				// a guess about ordering, so the chain stays unsegmented.
				return null;
			}
			if (!pushSegment(index)) return null;
			index += 2;
			// Skip the whitespace after the separator.
			while (index < command.length && /\s/.test(command[index]!)) index += 1;
			segmentStart = index;
			continue;
		}
		token += char;
		tokenStarted = true;
		index += 1;
	}

	if (quote) return null;
	if (!pushSegment(command.length)) return null;
	return segments.length > 0 ? segments : null;
}

/** An approval rule, ordered; the first match wins. */
export interface ApprovalRule {
	readonly match: string;
	readonly approval: "allow" | "deny" | "prompt";
	/** True when the rule matches the whole command rather than one segment. */
	readonly chainOnly?: boolean;
}

/** The decision a chain produced. */
export type ChainDecision =
	| { readonly kind: "deny"; readonly reason: string }
	| { readonly kind: "escalate"; readonly reason: string }
	| { readonly kind: "prompt"; readonly reason: string }
	| { readonly kind: "allow"; readonly reason: string };

/**
 * Whether a rule's pattern matches a command.
 *
 * ## The pattern is a glob, and this used to treat it as a regex
 *
 * This compiled `rule.match` directly as a regular expression, contradicting both
 * the setting's documented contract ("only * wildcards are supported") and the
 * sibling `commandMatches` in `approval-patterns.ts`. The consequences were not
 * subtle:
 *
 *     "rm *"       vs "charm setup"     -> matched
 *     "rm *"       vs "confirm --force" -> matched
 *     "npm run *"  vs "npm runbuild"    -> matched
 *     "git status" vs "git   status"    -> did not match
 *
 * `\ *` is a regex quantifier, so `rm *` means "rm" followed by zero or more
 * spaces, matching any command *containing* those letters rather than one
 * *starting* with `rm`. A user writing that rule to refuse deletes would instead
 * refuse `charm setup`, and a deny rule for `git status` would miss the spaced
 * spelling.
 *
 * So the glob matcher is used, which anchors at both ends and escapes every regex
 * metacharacter, making the two entry points agree.
 */
export function matches(rule: ApprovalRule, text: string): boolean {
	// `*` is a real catch-all in both dialects; short-circuiting it keeps the
	// empty-pattern guard below meaningful.
	if (rule.match === "*") return true;
	// An empty pattern matches nothing rather than everything. A rule with no text is
	// a mistake, and reading it as a catch-all would be the unsafe direction.
	// `patternToRegExp` cannot throw — it escapes everything but `*` — so a denial is
	// never silently dropped here, which the previous try/catch was guarding against.
	if (rule.match.trim().length === 0) return false;
	return commandMatches(text, rule.match);
}

/** The first rule matching a command, in order. */
export function firstMatch(command: string, rules: readonly ApprovalRule[]): ApprovalRule | undefined {
	return rules.find((rule) => !rule.chainOnly && matches(rule, command));
}

/**
 * Decides on a chain.
 *
 * Segments keep their ordered first-match semantics, so a specific allow still
 * wins for that segment. A rule that matches only the **whole chain** is
 * aggregated separately and the scan continues past a prompt, because any later
 * deny must stop the chain.
 */
export function decideChain(input: {
	readonly command: string;
	readonly rules: readonly ApprovalRule[];
	readonly compoundAllowed: boolean;
	readonly shell?: string;
	/** Patterns that always escalate, checked per segment when segmented. */
	readonly criticalPatterns?: readonly RegExp[];
}): ChainDecision {
	const segments =
		input.compoundAllowed && input.shell && isPosixShell(input.shell)
			? extractLiteralAndChainSegments(input.command)
			: null;

	// A whole-chain deny stops everything before any segment is considered.
	const chainDeny = input.rules.find(
		(rule) => rule.chainOnly && rule.approval === "deny" && matches(rule, input.command),
	);
	if (chainDeny) return { kind: "deny", reason: `Blocked by chain pattern: ${chainDeny.match}` };

	if (!segments) {
		// A chain the tokenizer refused to segment is treated as ONE opaque command,
		// and an allow-all rule set must not silently permit it: the whole reason
		// segmentation was refused is that we cannot say what the chain contains.
		// Every segment would have been allowed; here we can say none of them can be
		// shown to have been, so the chain prompts.
		const chainLooksCompound = /&&/.test(input.command);
		const rule = firstMatch(input.command, input.rules);
		if (rule?.approval === "deny") return { kind: "deny", reason: `Blocked by pattern: ${rule.match}` };
		// A critical pattern is escalated on an unsegmented command, because there
		// is no way to know which part triggered it.
		if (input.criticalPatterns?.some((pattern) => pattern.test(input.command))) {
			return { kind: "escalate", reason: "Critical pattern detected" };
		}
		if (rule?.approval === "allow" && !(chainLooksCompound && (rule.match === "*" || rule.match === ".*"))) {
			return { kind: "allow", reason: `Allowed by pattern: ${rule.match}` };
		}
		if (rule?.approval === "allow") {
			return {
				kind: "prompt",
				reason: "the chain could not be segmented, so a catch-all allow cannot vouch for what it contains",
			};
		}
		return { kind: "prompt", reason: "no rule matched" };
	}

	let promptRule: ApprovalRule | undefined;
	let hasUnmatchedSegment = false;
	for (const segment of segments) {
		// Checked per segment, so a critical pattern in one command of the chain
		// still escalates while one in another segment's arguments does not.
		if (input.criticalPatterns?.some((pattern) => pattern.test(segment.text))) {
			return { kind: "escalate", reason: `Critical pattern in segment: ${segment.text}` };
		}
		const rule = firstMatch(segment.text, input.rules);
		if (rule?.approval === "deny") return { kind: "deny", reason: `Blocked by pattern: ${rule.match}` };
		if (rule?.approval === "allow") continue;
		hasUnmatchedSegment = true;
		promptRule ??= rule;
	}
	if (hasUnmatchedSegment) {
		return { kind: "prompt", reason: promptRule ? `Prompt by pattern: ${promptRule.match}` : "an unmatched segment" };
	}
	return { kind: "allow", reason: "every segment matched an allow" };
}
