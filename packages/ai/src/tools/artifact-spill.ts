/**
 * Artifact spill: bounding a tool result without losing it.
 *
 * ## The problem
 *
 * A tool can return megabytes: a build log, a test run, a file dump. Inline,
 * that is the whole context window, and the model has nothing left to work
 * with. Truncated to a marker, the *result* is lost and the model cannot see
 * what happened.
 *
 * Spill does both: the full output is saved as an artifact, and the inline
 * content becomes a head-and-tail view with a reference to the artifact. The
 * model sees the beginning and the end - where errors are - and can read the
 * middle on demand.
 *
 * ## Head and tail, and why not just a tail
 *
 * The **head** carries the command, the setup and the first failures. The
 * **tail** carries the summary and the exit status. The middle is usually the
 * repetitive part. Keeping both ends is what makes the inline view useful
 * without opening the artifact.
 *
 * With `headBytes` at 0 the view is tail-only, which is the right shape for a
 * result whose *end* is what matters and whose start is noise.
 *
 * ## Two numbers, one budget
 *
 * The spill threshold bounds the artifact decision. The inline byte cap is the
 * final defence for a path that bypasses the sink entirely, and it sits
 * `INLINE_CAP_SLACK_BYTES` **above** the threshold.
 *
 * That slack is not slack for its own sake: the notice a sink-elided result
 * carries above the threshold — wall time, exit code, the elision marker, the
 * artifact footer — would otherwise trip the cap, and re-truncating a
 * sink-elided result re-saves it, producing a second artifact and a reference
 * that disagrees with the first. The cap is a last resort, not a second
 * truncation pass.
 *
 * ## A tool that already spilled is left alone
 *
 * A streaming executor that saved its own artifact must not be spilled again.
 * The result already carries metadata, and re-spilling produces the
 * `Artifact: N+1` against `artifact://N` mismatch the slack exists to prevent.
 */

import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Slack above the spill threshold for notice text: wall time, exit code, the
 * elision marker and the artifact footer all ride above the inline body.
 */
export const INLINE_CAP_SLACK_BYTES = 2 * 1024;

/** How a tool's large output is bounded. */
export interface SpillConfig {
	/** Bytes above which the full output is saved as an artifact. */
	readonly thresholdBytes: number;
	/** Bytes of the head kept inline. `0` means tail-only. */
	readonly headBytes: number;
	/** Bytes of the tail kept inline. */
	readonly tailBytes: number;
	/** Lines of the tail kept, applied after the byte budget. */
	readonly tailLines: number;
	/** Per-line column cap. */
	readonly maxColumns: number;
}

/** Builds a config from the user-facing settings, which are in kilobytes. */
export function spillConfigFrom(input: {
	readonly thresholdKb: number;
	readonly headKb: number;
	readonly tailKb: number;
	readonly tailLines: number;
	readonly maxColumns: number;
}): SpillConfig {
	return {
		thresholdBytes: Math.max(0, input.thresholdKb) * 1024,
		headBytes: Math.max(0, input.headKb) * 1024,
		tailBytes: Math.max(0, input.tailKb) * 1024,
		tailLines: Math.max(0, input.tailLines),
		maxColumns: Math.max(0, input.maxColumns),
	};
}

/** The final-defence cap: the user's threshold plus notice slack. */
export function inlineByteCap(config: SpillConfig): number {
	return config.thresholdBytes + INLINE_CAP_SLACK_BYTES;
}

/** A spilled view: what stays inline, and where the full output went. */
export interface SpillPlan {
	readonly spill: boolean;
	/** The inline text: head, a marker, and the tail. */
	readonly text: string;
	/** Why the result was or was not spilled. */
	readonly reason: string;
}

/** The marker that stands in for the elided middle. */
export const ELISION_MARKER = "[… middle elided …]";

/**
 * Truncates one line to the column cap.
 *
 * Applied per line rather than to the whole body, so a long line is cut without
 * the *count* of visible lines changing - which is what the tail budget is
 * counting.
 */
export function clampLineWidth(line: string, maxColumns: number): string {
	if (maxColumns <= 0 || line.length <= maxColumns) return line;
	return `${line.slice(0, Math.max(1, maxColumns - 1))}…`;
}

/** The tail, by lines first and then by bytes, so the line budget wins. */
function tailOf(text: string, config: SpillConfig): string {
	const lines = text.split("\n");
	let tail = config.tailLines > 0 ? lines.slice(-config.tailLines).join("\n") : lines.join("\n");
	if (config.tailBytes > 0 && tail.length > config.tailBytes) {
		tail = tail.slice(tail.length - config.tailBytes);
	}
	return config.maxColumns > 0
		? tail
				.split("\n")
				.map((line) => clampLineWidth(line, config.maxColumns))
				.join("\n")
		: tail;
}

/** The head, by bytes and then by column. */
function headOf(text: string, config: SpillConfig): string {
	let head = config.headBytes > 0 ? text.slice(0, config.headBytes) : "";
	if (config.maxColumns > 0)
		head = head
			.split("\n")
			.map((line) => clampLineWidth(line, config.maxColumns))
			.join("\n");
	return head;
}

/**
 * Decides whether a result spills, and what stays inline.
 *
 * Pure with respect to the store: the artifact id is a parameter rather than
 * something this function invents, so the decision is testable without one.
 */
export function planSpill(input: {
	readonly text: string;
	readonly config: SpillConfig;
	/** Set when the tool already saved its own artifact. */
	readonly alreadySpilled: boolean;
	/** The artifact holding the full output, when one exists. */
	readonly artifactRef?: string;
}): SpillPlan {
	const { text, config } = input;
	const bytes = Buffer.byteLength(text, "utf8");

	// A tool that already spilled must not spill again, or the second save
	// produces a reference that disagrees with the first.
	if (input.alreadySpilled) {
		return { spill: false, text, reason: "the tool already saved its own artifact" };
	}
	if (bytes <= config.thresholdBytes) {
		return { spill: false, text, reason: `${bytes} bytes is within the threshold` };
	}

	const tail = tailOf(text, config);
	const ref = input.artifactRef ?? "artifact://N";
	if (config.headBytes <= 0) {
		// Tail-only: right for a result whose end matters and whose start is noise.
		return {
			spill: true,
			text: `${tail}\n${ELISION_MARKER}\n${ref}`,
			reason: "head is disabled, so the view is tail-only",
		};
	}
	const head = headOf(text, config);
	// The head and tail can overlap on a result barely over the threshold; in that
	// case the whole text is shorter than the two views combined, so keeping it
	// whole is both smaller and more faithful.
	if (head.length + tail.length >= text.length) {
		return { spill: true, text, reason: "the head and tail views would cover the whole result" };
	}
	return {
		spill: true,
		text: `${head}\n${ELISION_MARKER}\n${tail}\n${ref}`,
		reason: `${bytes} bytes exceeds the threshold`,
	};
}

/** A tool result with a `meta` block indicating it already saved an artifact. */
export function alreadySpilled(result: { details?: unknown }): boolean {
	const details = result.details as { meta?: { source?: { type?: string } } } | undefined;
	return details?.meta?.source?.type === "internal";
}

/**
 * Applies the inline byte cap, as a last resort.
 *
 * Separate from {@link planSpill} because it is a *different* defence: the spill
 * threshold decides whether to save an artifact, and this bounds a result that
 * never went through that path. Running both on the same result is what produces
 * a double artifact.
 */
export function enforceInlineByteCap(text: string, config: SpillConfig, noticeBytes = 0): string {
	// The cap is the threshold plus slack, so a zero threshold still yields a
	// 2 KB ceiling rather than disabling the defence. Disabling it is a separate
	// decision, and conflating the two would make one setting mean both things.
	const cap = inlineByteCap(config);
	if (cap <= 0) return text;
	// Notice text rides above the body, so the budget is checked against body plus
	// notice rather than the body alone.
	if (Buffer.byteLength(text, "utf8") + noticeBytes <= cap) return text;
	const budget = Math.max(0, cap - noticeBytes);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= budget) return text;
	return `${text.slice(0, budget)}\n[truncated: ${bytes} bytes exceeded the inline cap]`;
}

/** The text of a tool result, for planning. */
export function resultText(message: ToolResultMessage): string {
	return contentText(message.content);
}
