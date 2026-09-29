/**
 * Tool-call loop guard: bounds a model reissuing the same failing call.
 *
 * ## The failure it prevents
 *
 * A model that gets a failing tool result can reissue the identical call
 * indefinitely. Each round costs a provider request and a tool invocation, and
 * nothing in the normal loop objects: the turn *succeeds* in the sense that it
 * completes, so a turn-failure counter never trips. The session simply gets
 * slower until it stops or the user interrupts.
 *
 * ## What counts as "the same call"
 *
 * The turn's tool calls are canonicalised and sorted, then hashed as a set.
 * Order within a turn does not matter, because a model that emits the same two
 * calls in the other order is doing the same thing.
 *
 * **The intent field is excluded** from the comparison. Intent is a hint about
 * *why* a call is being made, and it changes on every attempt even when the call
 * is identical - including it would make a genuine loop invisible. The legacy
 * `__intent` spelling is excluded for the same reason: a session written before
 * the rename would otherwise never match itself.
 *
 * ## Why a whole turn, not one call
 *
 * Hashing a turn rather than a call means a model alternating between two
 * failing calls - the classic retry-by-variation pattern - is not detected, and
 * that is deliberate. Alternating calls are the model trying something, and
 * suppressing exploration is worse than the cost. A model that reissues the
 * *same* set has stopped trying.
 *
 * ## Exempt tools
 *
 * A tool that is expected to be called repeatedly - a poll, a watch - would
 * trip the guard on its normal behaviour. A turn in which *every* call is exempt
 * resets the detector rather than counting, so an exempt tool cannot mask a loop
 * made of non-exempt ones on either side of it.
 */

import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

/** The current intent field, excluded from the comparison. */
const INTENT_FIELD = "intent";
/** The pre-rename spelling, excluded so a pre-rename session still matches itself. */
const LEGACY_INTENT_FIELD = "__intent";

const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

/**
 * Canonicalises a tool-call argument value for comparison.
 *
 * Keys are sorted, because two calls that differ only in argument order are the
 * same call; and intent is dropped, because it changes on every attempt even
 * when the call is identical.
 */
function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalizeToolCallValue(item));
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

/** One line, bounded, with an ellipsis when it was cut. */
function summarizeText(text: string, limit: number): string {
	const summary = text.replace(/\s+/g, " ").trim();
	return summary.length > limit ? `${summary.slice(0, limit)}…` : summary;
}

/** A bounded summary of the result a repeated call produced. */
function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find((candidate) => candidate.toolCallId === toolCallId);
	if (!result) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return summarizeText(parts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/**
 * Detects consecutive identical assistant tool calls across model turns.
 *
 * One instance per loop. It holds no state beyond the last hash and a count, so
 * it is cheap to construct and trivial to reset.
 */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		// A threshold below 1 would fire on the first turn, which is a detection
		// with nothing to detect.
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** The repetition count so far, for a status line. */
	get count(): number {
		return this.#count;
	}

	/** Clears the detector, at a turn or context boundary. */
	reset(): void {
		this.#lastHash = undefined;
		this.#count = 0;
	}

	/**
	 * Records one completed turn and reports a repetition at or beyond the
	 * threshold, or `null` when there is nothing to report.
	 */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");

		// A turn with no tool calls ends any run: the model stopped calling tools,
		// so the next call starts fresh however similar it looks.
		if (toolCalls.length === 0) {
			this.reset();
			return null;
		}
		// A turn of only exempt tools also ends the run. Counting it would let a
		// poll tool mask a real loop made of the calls around it.
		if (toolCalls.every((call) => this.#exemptTools.has(call.name))) {
			this.reset();
			return null;
		}

		// Sorted, because a model emitting the same two calls in the other order is
		// doing the same thing.
		const canonicalCalls = toolCalls
			.map((call) => JSON.stringify([call.name, canonicalizeToolCallValue(call.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);

		if (turnHash === this.#lastHash) this.#count++;
		else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		if (this.#count < this.#threshold) return null;
		// Report a non-exempt call, so the correction names something actionable.
		const reportCall = toolCalls.find((call) => !this.#exemptTools.has(call.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
