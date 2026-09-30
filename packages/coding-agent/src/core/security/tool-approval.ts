/**
 * The approval policy authority.
 *
 * This is the single place that answers "may this tool call run?". Every other
 * component — the agent loop, the TUI, an RPC host, a future ACP client — asks
 * here rather than deciding for itself, so the rules cannot diverge between
 * surfaces.
 *
 * ## Resolution order
 *
 *   1. tool-declared `deny`     — unconditional; nothing overrides it
 *   2. user-policy `deny`        — unconditional
 *   3. mode ceiling              — auto-approve up to the mode's tier
 *   4. user-policy `allow|prompt`
 *   5. tool-declared `allow|prompt`, or `override` prompt
 *   6. otherwise                 — prompt
 *
 * Deny is checked first and short-circuits, which makes it monotone: no
 * combination of permissive settings can turn a denial into an approval. That
 * ordering is the property worth protecting in review, so it is stated here
 * rather than left to the implementation.
 */

import {
	MAX_TOOL_RISK_TIER,
	modeApprovesTier,
	type ToolApproval,
	type ToolApprovalDeclaration,
	type ToolApprovalMode,
	type ToolApprovalPolicy,
	type ToolApprovalRequest,
	type ToolRiskTier,
} from "@earendil-works/pi-agent-core";

import { decideChain } from "../shell/compound-commands.ts";

/**
 * Command-level approval rules, as a user writes them.
 *
 * The reference's `bash.patterns` is an ordered list of `{ match, approval }`,
 * glob-matched and anchored. It is a *narrowing* mechanism: it can refuse a
 * command the mode would have allowed, and it can turn one the mode would prompt
 * for into a definite answer.
 *
 * It cannot widen past the mode's ceiling, and that is enforced by ordering
 * rather than by a check here: this runs before the tier comparison, so a
 * permissive pattern never gets the chance to override `always-ask`.
 */
export interface CommandApprovalRules {
	readonly patterns: readonly { match: string; approval: "allow" | "deny" | "prompt"; chainOnly?: boolean }[];
	/**
	 * Whether a literal `&&` chain may be segmented and judged per part.
	 *
	 * Segmentation is the difference between approving a read and running a delete,
	 * so it is a separate decision from the patterns and defaults to off.
	 */
	readonly compoundAllowed: boolean;
	/** Shell the command will run under. Only POSIX shells segment. */
	readonly shell?: string;
}

/**
 * What the command itself asks for, before the mode's ceiling applies.
 *
 * `unspecified` means the command carries no opinion, which is the common case:
 * most commands have no rule and fall through to their tier.
 */
export type CommandApproval =
	| { readonly kind: "unspecified" }
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "deny"; readonly reason: string }
	| { readonly kind: "prompt"; readonly reason: string }
	| { readonly kind: "escalate"; readonly reason: string };

/**
 * Asks the command rules what they think of one command.
 *
 * With no rules the answer is `unspecified` rather than `allow`, so a missing
 * configuration cannot silently become a permission.
 *
 * ## Why this delegates rather than reimplements
 *
 * `decideChain` already carries the security properties this needs, and they are
 * the ones that are easy to get subtly wrong: anchoring, per-segment judgement
 * of a segmentable chain, refusal to segment anything the tokenizer cannot
 * account for, a whole-chain deny outranking every segment allow, and a catch-all
 * allow being unable to vouch for a chain it could not take apart. A second
 * implementation would be a second set of those properties to keep correct.
 */
export function resolveCommandApproval(command: string, rules: CommandApprovalRules | undefined): CommandApproval {
	if (rules === undefined || rules.patterns.length === 0) return { kind: "unspecified" };

	const decision = decideChain({
		command,
		rules: rules.patterns,
		compoundAllowed: rules.compoundAllowed,
		...(rules.shell === undefined ? {} : { shell: rules.shell }),
	});

	if (decision.kind === "deny") return { kind: "deny", reason: decision.reason };
// Escalation is surfaced as a prompt rather than an allow: a critical pattern must
// never become a permission, and `always-ask` is the strictest thing available
// that still lets the operator decide.
	if (decision.kind === "escalate") return { kind: "prompt", reason: decision.reason };
	if (decision.kind === "prompt") return { kind: "prompt", reason: decision.reason };
	// `allow` means the rules vouch for the command. The caller's mode ceiling still
	// applies afterwards, so this cannot defeat `always-ask`.
	return { kind: "allow", reason: decision.reason };
}

/** A tool as far as approval is concerned: the fields this module reads. */
export interface ApprovableTool {
	name: string;
	approval?: ToolApproval;
	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
}

/** Where a decision came from. Useful in denial messages and in tests. */
export type ApprovalSource = "tool" | "user" | "mode";

/** A fully resolved decision, with the reasoning that produced it. */
export interface ResolvedToolApproval {
	policy: ToolApprovalPolicy;
	tier: ToolRiskTier;
	source: ApprovalSource;
	/** Text to show when prompting. */
	reason?: string;
	/** True when the tool forced a prompt the mode ceiling would have allowed. */
	override: boolean;
	/** The user-policy key consulted, which may be a sub-capability. */
	policyKey?: string;
}

/** Per-tool user policy, as configured. */
export type ToolApprovalPolicies = Readonly<Record<string, ToolApprovalPolicy>>;

/**
 * The policy inputs for one resolution.
 *
 * Grouped so a caller cannot accidentally pass a mode without policies and get
 * a decision that looks configured but is not.
 */
export interface ToolApprovalContext {
	mode: ToolApprovalMode;
	policies: ToolApprovalPolicies;
	/**
	 * Whether an interactive surface exists to ask a question on.
	 *
	 * This is the fail-closed switch. When false, a decision that resolves to
	 * `prompt` becomes `denied` rather than `approved`.
	 */
	hasPrompt: boolean;
	/**
	 * Command-level rules for a shell tool, or undefined for a tool that takes no
	 * command.
	 *
	 * Deliberately per-call rather than per-tool: `bash` and `edit` both reach
	 * {@link resolveToolApproval}, and only the shell one has a command to judge.
	 * Attaching it to the tool would mean the shell rules applied to an edit.
	 */
	command?: CommandApprovalRules;
	/**
	 * The command itself, when the tool takes one.
	 *
	 * Read from the arguments rather than declared by the tool, because a tool that
	 * could describe its own command would be able to bypass the user's rules.
	 */
	commandText?: string;

}

/**
 * The tiers this module accepts.
 *
 * Declared locally rather than imported from `pi-agent-core` so tier validation
 * has no cross-package runtime dependency. A missing or half-built dependency
 * would otherwise make every tier check fail closed — technically safe, but for
 * the wrong reason, and an ordinary run would look like a policy denial.
 */
const RISK_TIERS: ReadonlySet<string> = new Set<ToolRiskTier>(["read", "write", "exec"]);

/** Whether a value names a risk tier. A type guard, so callers narrow. */
function isRiskTier(value: unknown): value is ToolRiskTier {
	return typeof value === "string" && RISK_TIERS.has(value);
}

/**
 * Evaluates a tool's own declaration against the arguments.
 *
 * Fail-closed: a declaration that cannot be evaluated — a function that throws,
 * or a value that is neither a tier nor a well-formed object — yields the most
 * privileged tier. A tool that cannot describe its own risk is treated as
 * dangerous, and in particular is never silently downgraded to `read`.
 */
export function resolveToolDeclaration(tool: ApprovableTool, args: unknown): ToolApprovalDeclaration {
	if (tool.approval === undefined) return MAX_TOOL_RISK_TIER;

	let declaration: ToolApprovalDeclaration;
	try {
		declaration = typeof tool.approval === "function" ? tool.approval(args) : tool.approval;
	} catch {
		return MAX_TOOL_RISK_TIER;
	}

	if (typeof declaration === "string") {
		return isRiskTier(declaration) ? declaration : MAX_TOOL_RISK_TIER;
	}
	if (!declaration || typeof declaration !== "object") return MAX_TOOL_RISK_TIER;
	if (!isRiskTier(declaration.tier)) return MAX_TOOL_RISK_TIER;

	const policy = declaration.policy;
	if (policy !== undefined && policy !== "allow" && policy !== "deny" && policy !== "prompt") {
		return MAX_TOOL_RISK_TIER;
	}
	return declaration;
}

/**
 * Looks up the user policy for a decision.
 *
 * A tool may nominate a sub-capability through `policyKey`, so one tool with
 * several capabilities can be governed separately. Falls back to the tool name
 * when the nominated key has no policy of its own.
 */
function resolveUserPolicy(
	policies: ToolApprovalPolicies,
	toolName: string,
	declaredKey: string | undefined,
): { policy: ToolApprovalPolicy; key: string } | undefined {
	if (declaredKey && policies[declaredKey] !== undefined) {
		return { policy: policies[declaredKey], key: declaredKey };
	}
	if (policies[toolName] !== undefined) {
		return { policy: policies[toolName], key: toolName };
	}
	return undefined;
}

/**
 * Resolves whether a tool call may run.
 *
 * Pure: it asks nothing and prompts for nothing. A returned `prompt` means
 * "an operator decision is required", which the caller must obtain through a
 * real interactive surface or treat as a refusal.
 */
export function resolveToolApproval(
	tool: ApprovableTool,
	args: unknown,
	context: ToolApprovalContext,
): ResolvedToolApproval {
	const declaration = resolveToolDeclaration(tool, args);
	// Normalized once, so the rest of the function never re-narrows the union. A
	// bare tier string is the common case and carries no extra fields.
	const objectForm = typeof declaration === "string" ? undefined : declaration;
	const tier: ToolRiskTier = objectForm === undefined ? (declaration as ToolRiskTier) : objectForm.tier;
	const override = objectForm?.override === true;
	const reason = objectForm?.reason;
	const user = resolveUserPolicy(context.policies, tool.name, objectForm?.policyKey);

	// 1. A tool that refuses is refused. No setting, mode, or user policy undoes it.
	if (objectForm?.policy === "deny") {
		return { policy: "deny", tier, source: "tool", override, reason, policyKey: objectForm.policyKey };
	}

	// 2. A user policy that refuses is refused, for the same reason.
	if (user?.policy === "deny") {
		return {
			policy: "deny",
			tier,
			source: "user",
			override,
			reason: user.policy === "deny" ? reason : undefined,
			policyKey: user.key,
		};
	}

	// 3. The command's own rules, for a shell tool.
	//
	// Placed after the two denials and before the mode ceiling, which is what makes
	// a pattern a narrowing mechanism rather than a second authority:
	//
	// - after a tool or user denial, so a pattern cannot un-deny;
	// - before the ceiling, so an `allow` pattern still cannot defeat `always-ask`.
	//
	// A deny here is final; a prompt here forces the question even below the
	// ceiling, which is how an operator asks to be consulted for a command they
	// usually do not want to see unprompted.
	const command = context.commandText === undefined ? { kind: "unspecified" as const } : resolveCommandApproval(context.commandText, context.command);
	if (command.kind === "deny") {
		return { policy: "deny", tier, source: "user", override, reason: command.reason, policyKey: "command" };
	}
	if (command.kind === "prompt" && modeApprovesTier(context.mode, tier)) {
		return { policy: "prompt", tier, source: "user", override, reason: command.reason, policyKey: "command" };
	}

	// 4. The mode ceiling auto-approves anything at or below it.
	//
	// `yolo` is handled by `modeApprovesTier` returning true for every tier, so
	// there is no separate branch and no way for the two to disagree.
	if (modeApprovesTier(context.mode, tier)) {
		// A user `prompt` still applies below the ceiling: an operator can ask to be
		// consulted even for a read.
		if (user?.policy === "prompt") {
			return { policy: "prompt", tier, source: "user", override, reason, policyKey: user.key };
		}
		return { policy: "allow", tier, source: "mode", override: false, policyKey: objectForm?.policyKey };
	}

	// A command rule that allows the command does not reach here: below the ceiling
	// nothing is auto-approved, and an `allow` pattern is explicitly not a licence to
	// skip the question. The user policy below is the only thing that can.
	if (command.kind === "allow") {
		return { policy: "prompt", tier, source: "user", override: false, reason: command.reason, policyKey: "command" };
	}

	// 5. Below the ceiling is impossible here, so everything remaining is a prompt.
	//
	// An explicit tool `allow` cannot outrank a mode that asked to be consulted:
	// otherwise `always-ask` could be defeated by any tool that declared itself
	// allowed. Only the user's own policy can.
	if (user?.policy === "allow") {
		return { policy: "allow", tier, source: "user", override: false, policyKey: user.key };
	}

	return {
		policy: "prompt",
		tier,
		source: override ? "tool" : "mode",
		override,
		reason,
		policyKey: objectForm?.policyKey,
	};
}

/**
 * Builds the question to put to an operator.
 *
 * Kept separate from the decision so a host can render it however it likes —
 * a dialog now, a protocol message later — without the resolution logic
 * changing. `formatApprovalDetails` lines are flattened and empties dropped so
 * a UI never has to defend against a tool returning blank lines.
 */
export function buildApprovalRequest(
	tool: ApprovableTool,
	args: unknown,
	resolved: ResolvedToolApproval,
): ToolApprovalRequest {
	let details: string[] = [];
	try {
		const formatted = tool.formatApprovalDetails?.(args);
		if (typeof formatted === "string") {
			details = formatted.trim() ? [formatted] : [];
		} else if (Array.isArray(formatted)) {
			details = formatted.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
		}
	} catch {
		// A tool that cannot describe itself is still approvable; the tier and
		// name are enough to ask a meaningful question.
		details = [];
	}

	return {
		toolName: tool.name,
		tier: resolved.tier,
		prompt: `Allow ${tool.name}?`,
		details,
		args,
		policy: resolved.policy,
		reason: resolved.reason,
	};
}

/**
 * The message shown when a denial must be explained.
 *
 * Distinguishes a tool-owned refusal from a user-configured one, because the
 * operator's next step differs: the first needs a code change, the second a
 * config change.
 */
export function describeDenial(toolName: string, resolved: ResolvedToolApproval): string {
	if (resolved.source === "tool") {
		return resolved.reason
			? `Tool "${toolName}" is blocked by tool policy. Reason: ${resolved.reason}`
			: `Tool "${toolName}" is blocked by tool policy.`;
	}
	const key = resolved.policyKey ?? toolName;
	return (
		`Tool "${key}" is blocked by user policy.\n` +
		`To allow it, remove the "deny" entry for "${key}" from the tool approval configuration.`
	);
}
