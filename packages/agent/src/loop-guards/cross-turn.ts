/**
 * Cross-turn loop guards: bounding a model that will not stop repeating itself.
 *
 * ## The gap this fills
 *
 * `ToolCallLoopGuard` in `ai/utils/tool-call-loop-guard.ts` already recognises a
 * repeated call. Nothing consumed it. The detector produced a verdict and the
 * verdict went nowhere, so a model could call one tool with identical arguments
 * until its budget ran out.
 *
 * ## Two strikes, and the second one is not a redirect
 *
 * A first offence gets a corrective naming the tool, the count, the arguments
 * and the last result. Most models change course from that alone.
 *
 * A model that ignores the corrective will not be reasoned with, so the second
 * offence **aborts the turn**. Two redirects would invite an unbounded sequence
 * of them, each costing a full turn.
 *
 * The guard is deliberately **re-armed after the first corrective**. If it were
 * not, the detection state that produced the first redirect would still be
 * present on the next turn, the same bound would trip again immediately, and the
 * escalation would fire on offence one — the abort would be unreachable in
 * exactly the situation it exists for.
 *
 * ## A private loop gets its own instance
 *
 * An advisor drives a loop that never passes through the primary's guards. A
 * turn there that succeeds while burning dozens of identical failing calls is
 * invisible to any whole-turn failure counter, so each loop needs its own guard
 * and one instance per loop: the state is a last-hash and a count, and sharing it
 * across two concurrent loops would make each one's calls look like the other's.
 */

import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@earendil-works/pi-ai";
import {
	renderToolCallLoopRedirect,
	type ToolCallLoopRedirectDetails,
	toolCallLoopRedirectDetails,
} from "./tool-call-loop-redirect.ts";

export {
	renderToolCallLoopRedirect,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
	type ToolCallLoopRedirectDetails,
	toolCallLoopRedirectDetails,
} from "./tool-call-loop-redirect.ts";

export interface LoopGuardSettings {
	readonly enabled: boolean;
	readonly threshold: number;
	readonly exemptTools: readonly string[];
}

/** What the host has to provide so a guard can act. */
export interface LoopGuardHost {
	readonly settings: LoopGuardSettings;
	/** Name for log attribution. */
	readonly name: string;
	/** The loop's live message array, which the loop reads on the next request. */
	liveMessages(): readonly unknown[];
	/** Appends to the live array when the caller passed a detached snapshot. */
	appendMessage(message: unknown): void;
	/** Stops the current turn. */
	abort(reason: Error): void;
	/** Log sink; defaults to no logging so a host need not provide one. */
	warn?(message: string, fields: Record<string, unknown>): void;
}

/** What a guard decided to do about one completed turn. */
export type LoopGuardAction =
	| { readonly action: "none" }
	| { readonly action: "redirect"; readonly message: unknown; readonly details: ToolCallLoopRedirectDetails }
	| { readonly action: "abort"; readonly reason: Error };

/**
 * The redirect's text, so a host can wrap it in whichever message shape its own
 * agent converts to LLM context.
 *
 * Exposed separately from the action because the primary maps custom message
 * types and a private loop runs the default converter, which keeps only
 * LLM-native roles. A custom message handed to the default converter is dropped
 * before the request and corrects nothing.
 */
export function redirectText(detection: RepeatedToolCallDetection): string {
	return renderToolCallLoopRedirect(detection);
}

/**
 * Whether a value is an assistant message the detector can read.
 *
 * Checks the role and that the content is an array, because the detector filters
 * content for tool calls. A user message carries a string, and a tool result
 * carries neither, so both would throw rather than simply not matching.
 */
function isAssistantMessage(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { role?: unknown; content?: unknown };
	return candidate.role === "assistant" && Array.isArray(candidate.content);
}

export class CrossTurnLoopGuard {
	readonly #host: LoopGuardHost;
	#guard: ToolCallLoopGuard | undefined;
	#guardSettingsKey: string | undefined;
	#redirectIssued = false;

	constructor(host: LoopGuardHost) {
		this.#host = host;
	}

	/**
	 * Clears detector and escalation state.
	 *
	 * Called at a context boundary. Carrying a count across a compaction would let
	 * a loop that was merely interrupted resume its escalation, and a redirect
	 * issued before the boundary is not in the context the next request reads.
	 */
	reset(): void {
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		this.#redirectIssued = false;
	}

	/** Whether a redirect has been issued since the last reset. */
	get redirected(): boolean {
		return this.#redirectIssued;
	}

	/**
	 * The repetition count so far, for a status line. Zero when not counting.
	 *
	 * Resolved through the live settings rather than read off the existing guard, so
	 * a threshold or exemption change is reflected immediately instead of one turn
	 * later — a status line showing a stale count is worse than showing none.
	 */
	get count(): number {
		return this.#activeGuard()?.count ?? 0;
	}

	/**
	 * Records one completed turn and decides.
	 *
	 * `message` must be the assistant message for the turn; anything else is not a
	 * turn the guard has an opinion about.
	 */
	recordTurn(input: { message: unknown; toolResults: readonly unknown[] }): LoopGuardAction {
		// Enforced rather than documented. The detector indexes `message.content` as an
		// array of tool calls, which is only true of an assistant message; handing it a
		// user or tool message throws deep inside the detector instead of being
		// ignored, and a caller wiring this into a generic turn hook has no reason to
		// know that.
		if (!isAssistantMessage(input.message)) return { action: "none" };
		const guard = this.#activeGuard();
		if (guard === undefined) return { action: "none" };
		const detection = guard.recordTurn({
			// The guard reads the assistant message's tool calls and the matching
			// results; the shapes are the agent package's, narrowed here so this
			// module does not re-declare them.
			message: input.message as Parameters<ToolCallLoopGuard["recordTurn"]>[0]["message"],
			toolResults: input.toolResults as Parameters<ToolCallLoopGuard["recordTurn"]>[0]["toolResults"],
		});
		if (detection === null || detection === undefined) return { action: "none" };

		if (this.#redirectIssued) {
			// A model that ignored the corrective will not be reasoned with. Two
			// redirects would invite an unbounded sequence of them.
			const reason = new Error(`${this.#host.name} repeated ${detection.toolName} after a loop redirect`);
			this.#host.warn?.(`${this.#host.name} ignored tool-call loop redirect; aborting`, {
				toolName: detection.toolName,
				count: detection.count,
			});
			this.reset();
			return { action: "abort", reason };
		}

		this.#warnDetected(detection);
		this.#redirectIssued = true;
		// Re-arm after the first corrective. Without this the detection state that
		// produced the redirect survives into the next turn, the same bound trips
		// again immediately, and the abort fires on offence one.
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		return {
			action: "redirect",
			message: redirectText(detection),
			details: toolCallLoopRedirectDetails(detection),
		};
	}

	#warnDetected(detection: RepeatedToolCallDetection): void {
		this.#host.warn?.(`${this.#host.name} tool-call loop detected`, {
			toolName: detection.toolName,
			count: detection.count,
		});
	}

	#activeGuard(): ToolCallLoopGuard | undefined {
		if (!this.#host.settings.enabled) {
			// Disabling clears the count too, so re-enabling does not resume an
			// escalation the user turned off.
			this.#guard = undefined;
			this.#guardSettingsKey = undefined;
			return undefined;
		}
		const threshold = this.#host.settings.threshold;
		const exemptTools = this.#host.settings.exemptTools.filter(
			(tool): tool is string => typeof tool === "string" && tool.length > 0,
		);
		// The settings are part of the identity: a guard built at one threshold does
		// not carry a count valid at another.
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (this.#guard === undefined || this.#guardSettingsKey !== settingsKey) {
			this.#guard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#guardSettingsKey = settingsKey;
		}
		return this.#guard;
	}
}
