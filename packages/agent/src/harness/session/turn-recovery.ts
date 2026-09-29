/**
 * Turn recovery: what to do about an assistant turn that failed.
 *
 * ## What this is for
 *
 * A turn can end in an error with no useful content: a rate limit, a dead
 * credential, a model that stopped unexpectedly. Left alone, that empty error
 * turn is persisted and the user sees a bare failure with no indication that
 * anything was tried. This module classifies what happened and produces the
 * note that says so.
 *
 * ## The classification is ordered, and the order is the rule
 *
 * `credential` beats `model` beats `wait` beats `plain`. A single turn can
 * satisfy more than one - a switched credential *and* a delay, say - and the
 * note has to name the one that actually explains the recovery. Credential
 * first because switching accounts is the most surprising thing that can have
 * happened and the most useful for the user to know; `plain` last because it is
 * the residual case, and a bare "error" tells nobody anything.
 *
 * ## Why an empty error turn is special
 *
 * A turn that errored *with* content - text, thinking, a tool call, or a block
 * kind this build does not recognise - is not empty and is not up for
 * replacement. The user may be looking at real output that happened to arrive
 * alongside a failure. Only a turn that produced nothing is a candidate for the
 * retry presentation to supersede.
 *
 * ## Unknown block kinds count as content
 *
 * A transcript replayed from disk predates the current shapes. A new block type
 * that this build does not recognise is treated as content rather than ignored,
 * because the alternative is silently discarding a turn that a newer build
 * wrote and this build cannot read. Losing a turn is worse than showing an
 * unfamiliar block.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

/** What recovered a turn, from the user's point of view. */
export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

/** Presentation state for an error superseded by an automatic retry. */
export interface AssistantRetryRecovery {
	readonly kind: "auto-retry";
	readonly status: "recovered" | "pending" | "abandoned";
	readonly attempt: number;
	readonly recovery: AssistantRetryRecoveryKind;
	readonly note: string;
}

/** The message shape this rule needs, so it can be tested with a literal. */
type ErrorTurnLike = Pick<AssistantMessage, "stopReason" | "content">;

/**
 * Whether an assistant turn failed having produced nothing at all.
 *
 * The `default` branch is load-bearing: a block kind this build does not
 * recognise counts as content, so a turn written by a newer build is never
 * silently discarded by an older one.
 */
export function isEmptyErrorTurn(message: ErrorTurnLike): boolean {
	if (message.stopReason !== "error") return false;
	return !message.content.some((block) => {
		switch (block.type) {
			case "text":
				return hasText(block);
			case "thinking": {
				// A redacted thinking block still carries an opaque payload, which the
				// provider needs for multi-turn continuity. Treating it as empty would
				// make the retry presentation supersede a turn whose reasoning is still
				// load-bearing for the next request.
				if (block.redacted) return hasText({ text: block.thinkingSignature });
				return hasText({ text: block.thinking }) || hasText({ text: block.thinkingSignature });
			}
			case "toolCall":
				// A tool call is an action, not commentary: the model did something,
				// so the turn is not empty even if it said nothing.
				return true;
			default:
				// An unknown or newly-added block kind counts as content. A transcript
				// written by a newer build must never be silently discarded by an
				// older one, because the user cannot tell an elided turn from one
				// that never happened.
				return true;
		}
	});
}

/** Non-whitespace text. Tolerates a missing field: a replayed transcript predates current shapes. */
function hasText(content: { text?: unknown }): boolean {
	return typeof content.text === "string" && content.text.trim().length > 0;
}

/** What the retry attempt actually did. */
export interface RecoveryOutcome {
	/** A different credential was selected. */
	readonly switchedCredential: boolean;
	/** A different model was selected. */
	readonly switchedModel: boolean;
	/** How long the attempt waited before retrying, in milliseconds. */
	readonly delayMs: number;
	/** The provider flagged a usage limit, which is what makes a wait meaningful. */
	readonly usageLimit: boolean;
	/** The provider flagged a rate limit, reported separately in the note. */
	readonly rateLimited: boolean;
}

/**
 * Classifies a recovery.
 *
 * Credential first, then model, then a usage-limit wait, then the residual.
 * A wait only counts as a *wait* when a usage limit caused it: waiting for a
 * rate limit is already reported as rate-limited, and calling it "waited" as
 * well would say the same thing twice.
 */
export function classifyRecovery(outcome: RecoveryOutcome): AssistantRetryRecoveryKind {
	if (outcome.switchedCredential) return "credential";
	if (outcome.switchedModel) return "model";
	if (outcome.usageLimit && outcome.delayMs > 0) return "wait";
	return "plain";
}

/**
 * The one-line note attached to a recovered turn.
 *
 * Written for a human scanning a transcript, so it names the thing that
 * explains the recovery and nothing else.
 */
export function describeRecovery(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
	const parts: string[] = [];
	// Rate-limited and plain are alternatives: a rate-limited turn should not
	// also be described as an error, since neither word adds anything there.
	if (rateLimited) {
		parts.push("rate-limited");
	} else if (recovery === "plain") {
		parts.push("error");
	}
	if (recovery === "credential") parts.push("switched account");
	else if (recovery === "model") parts.push("switched model");
	else if (recovery === "wait") parts.push("waited");
	parts.push("retried");
	return parts.join("; ");
}

/** Builds the persisted recovery record for an attempt. */
export function buildRecovery(attempt: number, outcome: RecoveryOutcome): AssistantRetryRecovery {
	const recovery = classifyRecovery(outcome);
	return {
		kind: "auto-retry",
		status: "recovered",
		attempt,
		recovery,
		note: describeRecovery(recovery, outcome.rateLimited),
	};
}

/**
 * A stable key for a persisted message, used to find the branch entry a retry
 * superseded.
 *
 * Returns `undefined` when the message cannot be addressed - a message with no
 * timestamp or response id is not uniquely identifiable, and matching on
 * content alone would supersede the wrong turn when two turns are identical.
 */
export function sessionMessagePersistenceKey(message: { responseId?: string; timestamp?: number }): string | undefined {
	if (typeof message.responseId === "string" && message.responseId.length > 0) {
		return `response:${message.responseId}`;
	}
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
		return `ts:${message.timestamp}`;
	}
	return undefined;
}
