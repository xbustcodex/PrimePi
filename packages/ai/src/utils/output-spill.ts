/**
 * Output spill: what a tool shows inline when its result is too large.
 *
 * ## The threshold decides *whether*; the budgets decide *what*
 *
 * These are two different questions and conflating them is the easy mistake.
 * `spillThresholdKb` answers "is this result too large to inline at all". Only
 * once it says yes do `headBytes` and `tailBytes` decide how much survives. A
 * result over the threshold with generous budgets still spills to the budgeted
 * view; a result under it is returned whole regardless of how small the budgets
 * are. So a test whose fixture is over the threshold but whose budgets are
 * generous measures the budgets, not the threshold, and vice versa.
 *
 * ## Middle elision, and why not head-only or tail-only
 *
 * A tool result is interesting at both ends. A build log's setup is at the top
 * and its error is at the bottom; keeping either end alone discards the half
 * that explains the other. So the middle is elided and both ends are kept.
 *
 * `headBytes: 0` means tail-only, which is a real configuration and not a
 * degenerate one: for a stream where only the final state matters, the head is
 * pure cost.
 *
 * ## Truncation is not conditional on the recovery link
 *
 * When the elided bytes are also saved so they stay reachable, the truncation
 * still happens if that save fails. A disk-full or permission error must not
 * re-expose the full result — that is precisely the context-blowing output the
 * spill exists to prevent — and it must not turn a successful call into an
 * error. So the caller truncates unconditionally and attaches the recovery
 * reference only when a save actually succeeded.
 *
 * ## Elision is reported as a count, not as a gap
 *
 * A model can act on "400 lines are missing" and re-read them. A silent gap tells
 * it the output simply ended there, which is the belief that produces a wrong
 * conclusion about what happened.
 */

/** The spill policy, in the units a user reads. */
export interface OutputSpillSettings {
	/** Total size in KB above which a result is not returned inline in full. */
	readonly spillThresholdKb: number;
	/** Bytes kept from the start. Zero means tail-only. */
	readonly headBytes: number;
	/** Bytes kept from the end. */
	readonly tailBytes: number;
	/** Lines kept from the end, bounding a tail made of very short lines. */
	readonly tailLines: number;
	/** Maximum width of a single output line. */
	readonly maxColumns: number;
}

/**
 * Defaults, matching OMP.
 *
 * The head and tail budgets are equal because there is no principled way to
 * prefer one end: whether the interesting part is at the start or the end
 * depends on the tool and the command, not on anything knowable in advance.
 */
export const DEFAULT_OUTPUT_SPILL: OutputSpillSettings = {
	spillThresholdKb: 50,
	headBytes: 20 * 1024,
	tailBytes: 20 * 1024,
	tailLines: 500,
	maxColumns: 768,
};

/** How the elided middle is reported. */
export type SpillDirection = "none" | "tail" | "middle";

export interface SpillResult {
	/** What to return inline. */
	readonly content: string;
	/** True when anything was elided. */
	readonly spilled: boolean;
	readonly direction: SpillDirection;
	readonly totalBytes: number;
	readonly totalLines: number;
	readonly outputBytes: number;
	readonly outputLines: number;
	/** The line ranges retained, for a renderer that shows the elision. */
	readonly headLines?: number;
	readonly tailLines?: number;
}

/** Counts lines the way the truncators do: a trailing newline does not add one. */
export function countOutputLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.length;
}

/**
 * Applies the spill policy to one result body.
 *
 * The two limits are checked in the order that makes the policy readable: the
 * threshold first, because it is the coarse "does this fit at all" question, and
 * the budgets only once the answer is yes.
 */
export function spillOutput(content: string, settings: OutputSpillSettings): SpillResult {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const totalLines = countOutputLines(content);
	// The threshold is a fraction of a kilobyte, not a whole one: the setting offers
	// 2.5 KB, and truncating it would silently make that option mean 2 KB. Rounded
	// rather than floored, so a value just under a kilobyte does not round up to a
	// limit the user did not ask for.
	const thresholdBytes = Math.max(0, Math.round(settings.spillThresholdKb * 1024));

	// Under the threshold nothing is restructured, however small the budgets are.
	// Spilling here would make a 2 KB result lose content to a 20 KB budget the
	// user set for a different reason.
	if (totalBytes <= thresholdBytes) {
		return {
			content,
			spilled: false,
			direction: "none",
			totalBytes,
			totalLines,
			outputBytes: totalBytes,
			outputLines: totalLines,
		};
	}

	const lines = content.split("\n");

	// A head budget of zero is tail-only, which is a supported configuration rather
	// than a degenerate one: for a stream where only the final state matters the
	// head is pure cost.
	const headBytes = Math.max(0, Math.trunc(settings.headBytes));
	const tailBytes = Math.max(0, Math.trunc(settings.tailBytes));
	const tailLines = Math.max(0, Math.trunc(settings.tailLines));

	if (headBytes === 0) {
		const kept = lines.slice(Math.max(0, lines.length - tailLines));
		// Dropping every line but the last would leave a marker describing content
		// that is not there; an all-elided result is reported as the tail it kept.
		if (kept.length === 0) {
			return {
				content,
				spilled: false,
				direction: "none",
				totalBytes,
				totalLines,
				outputBytes: totalBytes,
				outputLines: totalLines,
			};
		}
		const keptBody = trimToBytes(kept.join("\n"), tailBytes, false);
		const elidedLines = Math.max(0, totalLines - countOutputLines(keptBody));
		const notice = `\n\n[… ${elidedLines} lines elided; increase tools.artifactTailLines to see more …]`;
		return {
			content: keptBody + notice,
			spilled: true,
			direction: "tail",
			totalBytes,
			totalLines,
			outputBytes: Buffer.byteLength(keptBody, "utf8"),
			outputLines: countOutputLines(keptBody),
			tailLines: countOutputLines(keptBody),
		};
	}

	// Middle elision. The tail is bounded by bytes and by lines; the head takes
	// whatever the tail did not, so the two together honour both budgets rather
	// than one of them.
	//
	// The tail never takes more than half the content, even when tailLines exceeds
	// the line count. Without that clamp a tail budget larger than the result claims
	// the whole thing, leaves the head nothing, and the elided-lines guard below
	// reports "nothing was removed" for a result that the threshold just admitted to
	// the spill path -- so raising tailLines would silently disable spilling.
	const tailCap = Math.max(1, Math.floor(lines.length / 2));
	const tailStart = Math.max(0, lines.length - Math.min(tailLines, tailCap));
	const tailBody = trimToBytes(lines.slice(tailStart).join("\n"), tailBytes, false);
	const tailLineCount = countOutputLines(tailBody);

	// Walk backwards from the tail for the head, stopping at the head budget.
	let headLineCount = 0;
	let headBytesUsed = 0;
	const headCap = headBytes;
	for (let index = 0; index < tailStart; index++) {
		const lineBytes = Buffer.byteLength(lines[index]!, "utf8") + 1;
		if (headBytesUsed + lineBytes > headCap) break;
		headBytesUsed += lineBytes;
		headLineCount++;
	}

	const headBody = lines.slice(0, headLineCount).join("\n");
	const elidedLines = Math.max(0, totalLines - headLineCount - tailLineCount);

	// A budget wide enough to hold every line is not a spill. Reporting one would
	// insert a marker claiming lines were dropped when none were. The check is on
	// line coverage alone: a trailing newline is not a line, so counting it as
	// coverage would keep the marker on a result nothing was removed from.
	if (elidedLines === 0) {
		return {
			content,
			spilled: false,
			direction: "none",
			totalBytes,
			totalLines,
			outputBytes: totalBytes,
			outputLines: totalLines,
		};
	}

	const notice = `\n\n[… ${elidedLines} lines elided; re-run with a narrower scope or raise the output limits …]`;
	return {
		content: `${headBody}${notice}${tailBody}`,
		spilled: true,
		direction: "middle",
		totalBytes,
		totalLines,
		outputBytes: Buffer.byteLength(headBody + notice + tailBody, "utf8"),
		outputLines: headLineCount + tailLineCount + 1,
		headLines: headLineCount,
		tailLines: tailLineCount,
	};
}

/**
 * Trims a body to a byte budget without splitting a line.
 *
 * `fromEnd` keeps the last budget rather than the first. A partial trailing line
 * is dropped rather than cut mid-line, because a cut identifier is worse than an
 * absent one: it reads as a complete and wrong value rather than as truncated.
 */
function trimToBytes(body: string, maxBytes: number, fromEnd: boolean): string {
	if (maxBytes === 0) return "";
	if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
	const lines = body.split("\n");
	const kept: string[] = [];
	let used = 0;
	const ordered = fromEnd ? [...lines].reverse() : lines;
	for (const line of ordered) {
		const cost = Buffer.byteLength(line, "utf8") + 1;
		if (used + cost > maxBytes) break;
		used += cost;
		kept.push(line);
	}
	if (fromEnd) kept.reverse();
	return kept.join("\n");
}

/**
 * Clips every line to `maxColumns`, marking each clipped one.
 *
 * Separate from the spill because a single enormous line — a minified bundle, a
 * base64 blob, a one-row CSV — is a different problem from a long output, and one
 * such line would otherwise consume the entire budget by itself.
 */
export function clipColumns(content: string, maxColumns: number): { content: string; clipped: boolean } {
	// A non-positive or non-finite limit would clip every character. Treated as "no
	// limit", because a user who typed nonsense meant to relax it, not to erase the
	// output.
	if (!Number.isFinite(maxColumns) || maxColumns <= 0) return { content, clipped: false };
	const lines = content.split("\n");
	let clipped = false;
	const out = lines.map((line) => {
		if (line.length <= maxColumns) return line;
		clipped = true;
		return `${line.slice(0, maxColumns)}… [line clipped at ${maxColumns} columns]`;
	});
	return { content: out.join("\n"), clipped };
}
