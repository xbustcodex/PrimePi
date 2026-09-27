/**
 * Tool approval: the declaration layer.
 *
 * ## What this is for
 *
 * Every tool that can change something outside the conversation needs an answer
 * to one question before it runs: *may it?* Today nothing in Pi answers that
 * question centrally. Tools run because the model asked for them.
 *
 * This module supplies the vocabulary; the decision logic lives in
 * `@earendil-works/pi-coding-agent`'s `core/security/tool-approval.ts`, and
 * enforcement happens in the agent loop. Keeping the types here, beside
 * `AgentTool`, means a tool can declare its own risk without depending on the
 * application layer.
 *
 * ## The three rules that make this safe
 *
 * 1. **Deny prevents invocation.** A denied tool never executes. It is not run
 *    and then reported as denied; the call is refused before `execute` is
 *    reached, so it leaves no side effect of any kind.
 * 2. **A required prompt is never silently converted into approval.** When a
 *    decision is `prompt` and no interactive surface exists to ask, the answer is
 *    refusal. There is no path where a missing UI quietly becomes consent.
 * 3. **An unclassified tool is the most privileged kind.** Omitting a
 *    classification yields `exec`, so a tool added without thinking about its
 *    risk is treated as dangerous rather than harmless.
 */

/**
 * What a tool call can affect, ordered from least to most privileged.
 *
 * The ordering is the whole point: a policy can name a ceiling and be sure that
 * everything below it passes automatically, because `read < write < exec` is a
 * total order rather than a set membership test.
 */
export type ToolRiskTier = "read" | "write" | "exec";

/** Numeric rank of each tier. Shared so policy code cannot drift from the union. */
export const TOOL_RISK_RANKS: Readonly<Record<ToolRiskTier, number>> = Object.freeze({
	read: 0,
	write: 1,
	exec: 2,
});

/** The most privileged tier. The default for any tool that has not classified itself. */
export const MAX_TOOL_RISK_TIER: ToolRiskTier = "exec";

/** The most privileged outcome a decision can express. */
export type ToolApprovalPolicy = "allow" | "deny" | "prompt";

/**
 * The privilege ceiling a mode grants without asking.
 *
 * `yolo` names no ceiling, which is why it is represented as the absence of one
 * rather than as a fourth tier: it is a statement about prompting, not about risk.
 */
export type ToolApprovalMode = "always-ask" | "write" | "yolo";

/**
 * Highest tier each mode auto-approves.
 *
 * `always-ask` stops at `read` because even reading a file can disclose something
 * the operator did not intend to share. `yolo` has no entry because it imposes no
 * ceiling at all.
 */
export const TOOL_APPROVAL_MODE_MAX_TIER: Readonly<Record<Exclude<ToolApprovalMode, "yolo">, ToolRiskTier>> =
	Object.freeze({
		"always-ask": "read",
		write: "write",
	});

/** Whether a mode's ceiling covers a given tier. */
export function modeApprovesTier(mode: ToolApprovalMode, tier: ToolRiskTier): boolean {
	// `yolo` prompts for nothing, so it covers every tier including the top one.
	if (mode === "yolo") return true;
	return TOOL_RISK_RANKS[tier] <= TOOL_RISK_RANKS[TOOL_APPROVAL_MODE_MAX_TIER[mode]];
}

/**
 * What a tool declares about itself.
 *
 * A bare tier is a static classification. The object form additionally states a
 * policy, which lets a tool refuse outright or force a prompt regardless of the
 * mode's ceiling — so a dangerous tool cannot be made safe by a permissive
 * setting, only by editing the tool.
 */
export type ToolApprovalDeclaration =
	| ToolRiskTier
	| {
			tier: ToolRiskTier;
			/**
			 * Force this outcome. `deny` is unconditional; `prompt` ignores the mode
			 * ceiling unless the tool also sets `override: false`.
			 */
			policy?: ToolApprovalPolicy;
			/**
			 * Require a prompt even when the mode's ceiling would auto-approve.
			 * Has no effect under `yolo`, which is the point of a separate mode.
			 */
			override?: boolean;
			/** Shown to the operator when a prompt is required. */
			reason?: string;
			/**
			 * Which user policy key applies. For a tool that dispatches to
			 * sub-capabilities, this names the sub-capability rather than the tool.
			 */
			policyKey?: string;
	  };

/**
 * A tool's approval declaration, which may depend on the arguments.
 *
 * Argument-dependent declaration matters: `bash` running `git status` and
 * `bash` running `rm -rf /` are the same tool and not the same risk.
 */
export type ToolApproval = ToolApprovalDeclaration | ((args: unknown) => ToolApprovalDeclaration);

/**
 * A single question the caller must answer before a tool runs.
 *
 * Deliberately transport-shaped rather than UI-shaped: it carries the decision
 * and enough context to render any prompt, and it is returned rather than
 * resolved internally. That is what lets a TUI dialog today and an RPC or ACP
 * round-trip later serve the same request without the approval logic changing.
 */
export interface ToolApprovalRequest {
	/** Tool being invoked. */
	toolName: string;
	/** Tier the tool declared, after its declaration was resolved. */
	tier: ToolRiskTier;
	/** Line shown as the primary question. */
	prompt: string;
	/** Extra lines describing what is about to happen. */
	details: readonly string[];
	/** Valid arguments, so a UI can summarize or even edit the call. */
	args: unknown;
	/**
	 * The decision that was already reached before prompting. A UI can show this
	 * as context; the answer still wins.
	 */
	policy: ToolApprovalPolicy;
	/** Why this prompt is being shown. */
	reason?: string;
}

/** How a prompt was answered. */
export type ToolApprovalResponse = "allow" | "deny";

/**
 * The outcome of consulting an approval prompt.
 *
 * A prompt that cannot be asked resolves to `denied`, never to `approved`. The
 * `reason` distinguishes "the operator said no" from "there was nobody to ask",
 * because those call for different operator responses.
 */
export type ToolApprovalOutcome =
	| { status: "approved"; reason?: string }
	| { status: "denied"; reason: string; noPromptAvailable?: boolean };

/**
 * Asks the operator. Supplied by the host.
 *
 * A host with no interactive surface should not supply this at all, or should
 * resolve every request as denied. Silently returning "allow" would turn a
 * missing UI into consent, which rule 2 forbids.
 */
export type ToolApprovalPrompt = (request: ToolApprovalRequest) => Promise<ToolApprovalResponse>;
