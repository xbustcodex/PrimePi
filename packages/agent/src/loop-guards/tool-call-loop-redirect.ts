/**
 * The tool-call loop redirect: the corrective a repeated call earns.
 *
 * ## Why a redirect rather than an abort
 *
 * The detector in `tool-call-loop-guard.ts` recognises a model calling one tool
 * with identical arguments over and over. The tempting response is to stop the
 * turn, but a turn that is *succeeding* at the transport level while burning
 * dozens of identical failing calls is exactly the case a turn-failure counter
 * never catches — and it is recoverable. The model usually has the information
 * it needs and simply has not noticed it already tried this.
 *
 * So the first offence gets a corrective that names the tool, the count, the
 * arguments and the last result. That is enough for most models to change course
 * on their own.
 *
 * ## The wording is shared, the message shape is not
 *
 * The primary session's loop guard and the advisor's private loop both need this
 * text, and they must say the same thing — a model that sees two different
 * correctives for the same fault will treat one as noise. But the primary maps
 * custom message types into LLM context and the advisor runs the default
 * converter, which keeps only LLM-native roles. So the *renderer* is shared and
 * each caller wraps it in the shape its own agent understands. A custom message
 * handed to the advisor would be dropped before the request and would correct
 * nothing at all.
 *
 * ## One redirect, then a hard stop
 *
 * A redirect that is ignored is a model that will not be reasoned with. Allowing
 * a second redirect invites an unbounded sequence of them, so the second offence
 * aborts the turn instead. The guard is re-armed after the first corrective so
 * the escalation is actually reachable rather than being masked by the very
 * state that triggered it.
 */

import type { RepeatedToolCallDetection } from "@earendil-works/pi-ai";

/** The `customType` the primary session records a redirect under. */
export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/** Structured record of the loop a redirect was issued for. */
export interface ToolCallLoopRedirectDetails {
	readonly toolName: string;
	readonly count: number;
	readonly argumentsSummary: string;
	readonly resultSummary: string;
}

/**
 * The corrective text.
 *
 * Rendered from a constant rather than a template file: Pi keeps prompt text in
 * TypeScript, and a separate loader here would be a second convention for one
 * string. The result summary falls back to a literal so the sentence around it
 * never reads as a dangling blank.
 */
export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	return [
		'<system-interrupt reason="tool_call_loop_detected">',
		`You called \`${detection.toolName}\` ${detection.count} consecutive times with identical arguments:`,
		`\`${detection.argumentsSummary}\``,
		"",
		`Last result (truncated): \`${detection.resultSummary || "(no text result)"}\``,
		"",
		`NEVER call \`${detection.toolName}\` with those arguments again this turn. Use different arguments, choose another tool, or summarize findings and yield if complete.`,
		"</system-interrupt>",
	].join("\n");
}

/** The structured form, for a renderer that shows the loop rather than the text. */
export function toolCallLoopRedirectDetails(detection: RepeatedToolCallDetection): ToolCallLoopRedirectDetails {
	return {
		toolName: detection.toolName,
		count: detection.count,
		argumentsSummary: detection.argumentsSummary,
		resultSummary: detection.resultSummary,
	};
}
