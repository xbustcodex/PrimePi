/**
 * The approval gate: policy plus enforcement, as one unit.
 *
 * The loop already has exactly the seam this needs — `beforeToolCall`, which can
 * return `{ block: true }` and cause the call to be refused before `execute` is
 * ever reached. This module supplies the decision and adapts a denial into that
 * existing shape, rather than modifying the loop.
 *
 * That choice matters for the guarantee this phase is about. A denial returns an
 * immediate outcome, so the tool's `execute` is never invoked: there is no
 * partial effect, no half-written file, no started process. A design that ran
 * the tool and then reported "denied" would satisfy the same tests and none of
 * the actual property.
 */

import type {
	BeforeToolCallResult,
	ToolApprovalMode,
	ToolApprovalOutcome,
	ToolApprovalPolicy,
	ToolApprovalPrompt,
	ToolApprovalRequest,
	ToolRiskTier,
} from "@earendil-works/pi-agent-core";
import {
	buildApprovalRequest,
	describeDenial,
	type ResolvedToolApproval,
	resolveToolApproval,
	type ToolApprovalPolicies,
} from "./tool-approval.ts";

/** How the gate is configured for a session. */
export interface ApprovalGateOptions {
	mode: ToolApprovalMode;
	policies: ToolApprovalPolicies;
	/**
	 * Asks the operator, when an interactive surface exists.
	 *
	 * Omit it in a non-interactive host. The gate will then refuse anything that
	 * requires a prompt, which is the correct answer: no question was asked, so
	 * no consent exists.
	 */
	prompt?: ToolApprovalPrompt;
	/** For diagnostics: where the mode came from. */
	modeSource?: string;
}

/** What the gate decided about one call. */
export interface ApprovalDecision {
	policy: ToolApprovalPolicy;
	tier: ToolRiskTier;
	/** True only when an operator actively said yes. */
	approved: boolean;
	/** True when a prompt was required and could not be asked. */
	blockedWithoutPrompt?: boolean;
	reason?: string;
}

export type ApprovalResult =
	| { kind: "allow"; decision: ApprovalDecision }
	| { kind: "deny"; decision: ApprovalDecision; message: string };

/**
 * Decides whether one tool call may run, prompting only when required.
 *
 * The ordering guarantees a denial can never become an approval:
 *
 *   deny  -> refused here, no prompt, no execution
 *   allow -> permitted
 *   prompt + a prompt function -> ask, then honour the answer
 *   prompt + no prompt function -> refused, and reported as such
 *
 * The last line is the one that has to be right. A host without a UI must not
 * be able to accidentally authorize anything, so "cannot ask" is treated as
 * "no", never as "yes".
 */
export async function decideToolApproval(input: {
	tool: { name: string; approval?: unknown; formatApprovalDetails?: (args: unknown) => string | string[] | undefined };
	args: unknown;
	options: ApprovalGateOptions;
}): Promise<ApprovalResult> {
	const { tool, args, options } = input;
	const hasPrompt = typeof options.prompt === "function";

	const resolved: ResolvedToolApproval = resolveToolApproval(tool as never, args, {
		mode: options.mode,
		policies: options.policies,
		hasPrompt,
	});

	if (resolved.policy === "deny") {
		return {
			kind: "deny",
			decision: { policy: "deny", tier: resolved.tier, approved: false, reason: resolved.reason },
			message: describeDenial(tool.name, resolved),
		};
	}

	if (resolved.policy === "allow") {
		return {
			kind: "allow",
			decision: { policy: "allow", tier: resolved.tier, approved: true },
		};
	}

	// Policy requires an operator decision.
	if (!hasPrompt) {
		return {
			kind: "deny",
			decision: {
				policy: "prompt",
				tier: resolved.tier,
				approved: false,
				blockedWithoutPrompt: true,
				reason: resolved.reason,
			},
			message: describeNoPromptAvailable(tool.name, resolved.tier, options.mode),
		};
	}

	const request: ToolApprovalRequest = buildApprovalRequest(tool as never, args, resolved);
	let outcome: ToolApprovalOutcome;
	try {
		const response = await options.prompt!(request);
		outcome = response === "allow" ? { status: "approved" } : { status: "denied", reason: "denied by operator" };
	} catch (error) {
		// A prompt that throws has not granted consent.
		const detail = error instanceof Error ? error.message : String(error);
		outcome = { status: "denied", reason: `approval prompt failed: ${detail}`, noPromptAvailable: true };
	}

	if (outcome.status === "approved") {
		return { kind: "allow", decision: { policy: "allow", tier: resolved.tier, approved: true } };
	}

	return {
		kind: "deny",
		decision: {
			policy: "prompt",
			tier: resolved.tier,
			approved: false,
			blockedWithoutPrompt: outcome.noPromptAvailable === true,
			reason: outcome.reason,
		},
		message: `Tool "${tool.name}" was not approved: ${outcome.reason}`,
	};
}

/**
 * The refusal shown when a prompt is required and cannot be asked.
 *
 * States the two ways out explicitly, because "it did nothing" without a reason
 * is indistinguishable from a crash.
 */
export function describeNoPromptAvailable(toolName: string, tier: ToolRiskTier, mode: ToolApprovalMode): string {
	return (
		`Tool "${toolName}" requires approval (tier: ${tier}) but no interactive surface is available, ` +
		`so the call was refused rather than assumed safe.\n` +
		`Current approval mode: ${mode}.\n` +
		`Either run interactively, or configure this tool explicitly with an "allow" policy.`
	);
}

/**
 * Adapts the gate to the agent loop's `beforeToolCall` contract.
 *
 * `undefined` means "carry on", which is how the loop distinguishes an
 * uninteresting call from a blocked one. A denial becomes `{ block: true }`,
 * which the loop turns into an immediate error result and an early return before
 * `execute` runs.
 */
export async function toBeforeToolCallResult(result: ApprovalResult): Promise<BeforeToolCallResult | undefined> {
	if (result.kind === "allow") return undefined;
	return { block: true, reason: result.message };
}
