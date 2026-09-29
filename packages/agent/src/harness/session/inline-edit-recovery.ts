/**
 * Recovery for sloppy edit payloads the model emits as plain assistant text.
 *
 * ## The problem
 *
 * Models sometimes write a file edit as prose rather than calling the edit
 * tool: `*** Edit File: src/index.ts` followed by the payload, in a plain text
 * block. The user sees a file change they did not make, or no change at all
 * while the model claims one happened.
 *
 * ## Why it is lifted into a tool call rather than executed directly
 *
 * The recovered payload becomes a **synthetic tool call**, so the normal
 * pipeline handles it unchanged: validation, approval tiering, execution,
 * rendering, journaling, provider replay. A special path that applied the edit
 * itself would skip all of that — most importantly the approval gate, which is
 * a PrimePi authority that must not be bypassed by a convenience feature.
 *
 * ## When it must not fire
 *
 * **Only on a clean `stop` turn with no tool calls.**
 *
 * A `length`-truncated payload must never execute half an edit: the model was
 * cut off mid-write, and applying the fragment would corrupt a file. A turn
 * that already carries tool calls handled its own edits, so any quoted payload
 * in it is commentary the model is *discussing*, not issuing. Recovering that
 * would execute an edit the model never asked for.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

/** A located payload: the region it occupied and the text it contained. */
export interface InlineSloppyRegion {
	readonly start: number;
	readonly end: number;
	readonly payload: string;
}

/**
 * The payload header models emit.
 *
 * Anchored on the literal the reference uses, which is what the native
 * extractor in `pi-natives` matches. The header must begin a line, so a model
 * quoting the syntax inside a sentence is not recovered.
 */
const HEADER = /^\*\*\*\s+(?:Edit|Add|Update|Delete)\s+File:\s*(\S.*)$/;

/**
 * Finds sloppy edit payloads in a text block.
 *
 * A payload runs from its header to the end of the text, or to the next header
 * at the same kind. Only one kind is treated as a terminator, so a payload that
 * mentions the other syntax in prose does not truncate itself.
 */
export function extractInlineSloppyRegions(text: string): InlineSloppyRegion[] {
	const lines = text.split("\n");
	// Offsets of each line start, so a region is expressed in the original string
	// coordinates rather than reassembled from pieces.
	const offsets: number[] = [];
	let cursor = 0;
	for (const line of lines) {
		offsets.push(cursor);
		cursor += line.length + 1;
	}

	const regions: InlineSloppyRegion[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!HEADER.test(lines[index]!.trimStart())) continue;
		// The first header in a run opens a payload; the next header closes it, so
		// two separate edits become two regions rather than one merged blob.
		const start = offsets[index]!;
		let end = text.length;
		for (let scan = index + 1; scan < lines.length; scan++) {
			if (HEADER.test(lines[scan]!.trimStart())) {
				end = offsets[scan]!;
				break;
			}
		}
		regions.push({ start, end, payload: text.slice(start, end) });
		// Resume after the region, so a header inside it is not double-counted.
		while (index + 1 < lines.length && offsets[index + 1]! < end) index++;
	}
	return regions;
}

/** A tool call id that is unique within a session. */
function mintToolCallId(): string {
	return `inline-edit-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Lifts stray sloppy payloads in a message's text blocks into one synthetic
 * `edit` tool call.
 *
 * Mutates the message in place, because the reference does so through the
 * agent's `transformAssistantMessage` hook, which the caller owns. Returns the
 * number of payloads recovered; 0 means the message was not touched.
 */
export function recoverInlineSloppyEdit(message: AssistantMessage): number {
	// A truncated turn must never execute half an edit.
	if (message.stopReason !== "stop") return 0;
	// A turn that already carries tool calls handled its own edits; any payload
	// quoted in it is commentary, and executing it would be an edit nobody asked for.
	if (message.content.some((block) => block.type === "toolCall")) return 0;

	const payloads: string[] = [];
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const regions = extractInlineSloppyRegions(block.text);
		if (regions.length === 0) continue;
		// Lift the payload out of the prose, keeping the commentary around it.
		let remaining = "";
		let cursor = 0;
		for (const region of regions) {
			remaining += block.text.slice(cursor, region.start);
			cursor = region.end;
			payloads.push(region.payload);
		}
		remaining += block.text.slice(cursor);
		block.text = remaining;
	}
	if (payloads.length === 0) return 0;

	// A block emptied by the lift would leave a blank turn behind.
	message.content = message.content.filter((block) => !(block.type === "text" && block.text.trim() === ""));

	const input = payloads.join("\n");
	message.content.push({
		type: "toolCall",
		id: mintToolCallId(),
		name: "edit",
		arguments: { input },
	} as AssistantMessage["content"][number]);

	return payloads.length;
}
