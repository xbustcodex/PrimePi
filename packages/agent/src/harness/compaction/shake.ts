/**
 * "Shake": surgical context reduction that needs no model.
 *
 * ## Why this exists alongside pruning
 *
 * `pruning.ts` removes whole tool results. Shake removes *heavy content inside*
 * a message — a large fenced code block, a top-level XML element — replacing each
 * with a short placeholder while leaving the surrounding prose and every
 * non-text content block intact.
 *
 * It matters because the two attack different waste. A 200-line file read is
 * prunable. A 200-line stack trace inside an assistant message, or a `<diff>`
 * in a tool result that is otherwise worth keeping, is not: eliding the whole
 * message loses the two lines of explanation around it. Shake keeps the
 * explanation.
 *
 * The layering is deliberate and mirrors the reference: **this is the pure
 * layer** — region detection and in-place mutation only, no I/O. Artifact
 * offload, persistence and provider-session teardown belong to the caller.
 *
 * ## The same protections apply
 *
 * Shake shares `pruning.ts`'s protection and cache rules, for the same reasons:
 * a skill read or an artifact recovery is protected because eliding it mints
 * another one, and a warm prompt-cache prefix is never rewritten because the
 * re-write costs more than the saving.
 *
 * ## Detection is deliberately conservative
 *
 * An unterminated fence or tag yields **no range**. A half-detected block would
 * be replaced by a placeholder that does not describe what it replaced, and the
 * model would have no way to recover the content — a strictly worse outcome
 * than leaving the tokens in place.
 */

import {
	type AssistantMessage,
	contentText,
	type Message,
	type TextContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { estimateTokens } from "./compaction.ts";
import { collectToolCallsById, isProtectedToolResult, type ProtectedToolMatcher } from "./pruning.ts";

/** What a placeholder costs, for the savings estimate. */
const PLACEHOLDER_TOKENS = 16;

/** A tool result that carries no text to shake: images, files, audio. */
const NON_SHAKEABLE = /^(image|audio|file|pdf|video)_/;

export interface ShakeConfig {
	/** Recent context tokens to leave intact, counted across all messages. */
	readonly protectTokens: number;
	/** Only shake when the total estimated saving reaches this. */
	readonly minSavings: number;
	readonly protectedTools: readonly ProtectedToolMatcher[];
	/** A fenced or XML block smaller than this is not worth a placeholder. */
	readonly fenceMinTokens: number;
	/**
	 * A result whose all-message suffix exceeds this sits in the provider's warm
	 * cache prefix; mutating it re-writes the whole suffix. Undefined disables the
	 * guard.
	 */
	readonly cacheWarmSuffixTokens?: number;
}

export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 40_000,
	minSavings: 20_000,
	protectedTools: [],
	fenceMinTokens: 64,
};

/** An opening XML tag occupying its whole line. */
const OPENING_XML = /^<([a-zA-Z][\w.-]*)(?:\s[^>]*)?>$/;
/** A closing XML tag. */
const CLOSING_XML = /^<\/([a-zA-Z][\w.-]*)\s*>$/;

interface BlockRange {
	readonly start: number;
	readonly end: number;
}

/**
 * Locate fenced code blocks and top-level XML element spans in `text`.
 *
 * Ranges cover the full block including the opening and closing fence or tag
 * lines, excluding the trailing newline.
 *
 * XML detection is suppressed inside a fence, so a ``` block containing XML
 * yields one range, not two overlapping ones.
 */
export function scanTextForBlockRanges(text: string): BlockRange[] {
	const ranges: BlockRange[] = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;
	let lineStart = 0;

	for (let index = 0; index <= text.length; index++) {
		if (index !== text.length && text[index] !== "\n") continue;
		const line = text.slice(lineStart, index);
		const trimmed = line.trimStart();

		const isFence = trimmed.startsWith("```") || trimmed.startsWith("~~~");
		if (isFence) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				// An unterminated fence yields no range: a half-detected block would
				// be replaced by a placeholder that does not describe what it lost.
				inFence = false;
				if (fenceStart >= 0) ranges.push({ start: fenceStart, end: index });
				fenceStart = -1;
			}
			lineStart = index + 1;
			continue;
		}

		if (!inFence) {
			if (line.length === trimmed.length) {
				const opening = OPENING_XML.exec(trimmed);
				if (opening) {
					if (tagStack.length === 0) xmlStart = lineStart;
					tagStack.push(opening[1]!);
					lineStart = index + 1;
					continue;
				}
			}
			const closing = CLOSING_XML.exec(trimmed);
			// Only the innermost open tag may close, so `<a><b></a>` does not
			// produce a span that ends before its own content.
			if (closing && tagStack.length > 0 && tagStack[tagStack.length - 1] === closing[1]) {
				tagStack.pop();
				if (tagStack.length === 0 && xmlStart >= 0) {
					ranges.push({ start: xmlStart, end: index });
					xmlStart = -1;
				}
			}
		}
		lineStart = index + 1;
	}

	return mergeRanges(ranges);
}

/**
 * Drop ranges contained in an earlier one.
 *
 * Fences and XML spans are properly nested by construction, so an overlap
 * always means containment, and keeping the earlier-starting range keeps the
 * outermost span.
 */
function mergeRanges(ranges: readonly BlockRange[]): BlockRange[] {
	if (ranges.length <= 1) return [...ranges];
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const kept: BlockRange[] = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

/** A region of text eligible for a placeholder. */
export interface ShakeRegion {
	/** Index into the message array. */
	readonly messageIndex: number;
	/** Block index within the message's content, or -1 for a plain string. */
	readonly blockIndex: number;
	readonly start: number;
	readonly end: number;
	readonly tokens: number;
	/** What produced the region, shown in the placeholder. */
	readonly label: string;
}

/** Finds block regions inside one text block. */
function pushBlockRegions(
	messageIndex: number,
	blockIndex: number,
	text: string,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		if (slice.length === 0) continue;
		// A block smaller than the placeholder itself is not worth replacing.
		const tokens = Math.ceil(slice.length / 4);
		if (tokens < Math.max(config.fenceMinTokens, PLACEHOLDER_TOKENS)) continue;
		out.push({ messageIndex, blockIndex, start: range.start, end: range.end, tokens, label });
	}
}

/** Finds block regions across every message, tool results included. */
function collectBlockRegions(
	messages: readonly Message[],
	config: ShakeConfig,
	calls: ReadonlyMap<string, { id: string; name: string; arguments: Record<string, unknown> }>,
	out: ShakeRegion[],
): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant") {
			for (let blockIndex = 0; blockIndex < (message as AssistantMessage).content.length; blockIndex++) {
				const block = (message as AssistantMessage).content[blockIndex];
				if (block.type === "text") pushBlockRegions(index, blockIndex, block.text, config, "assistant", out);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			// The same protections pruning applies, for the same reasons.
			if (isProtectedToolResult(result, calls.get(result.toolCallId), config.protectedTools)) continue;
			// Non-text content is preserved whole: an image or a file reference has
			// no text to elide, and dropping it would lose the only content there is.
			if (NON_SHAKEABLE.test(result.toolName)) continue;
			for (let blockIndex = 0; blockIndex < result.content.length; blockIndex++) {
				const block = result.content[blockIndex] as TextContent;
				if (block.type === "text") pushBlockRegions(index, blockIndex, block.text, config, result.toolName, out);
			}
			continue;
		}
		const text = contentText((message as { content: string | TextContent[] }).content);
		if (text) pushBlockRegions(index, -1, text, config, message.role, out);
	}
}

/** Per-index token totals for the messages after it. */
function computeMessageSuffixTokens(messages: readonly Message[]): number[] {
	const totals = new Array<number>(messages.length).fill(0);
	let running = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		totals[index] = running;
		running += estimateTokens(messages[index] as AgentMessage);
	}
	return totals;
}

export interface ShakeResult {
	readonly messages: Message[];
	readonly shakenCount: number;
	readonly tokensSaved: number;
}

/** The placeholder written over a shaken region. */
export function createPlaceholder(label: string, tokens: number): string {
	return `[${label} block elided — ${tokens} tokens]`;
}

/**
 * Replaces heavy blocks with placeholders, returning a **new** message array.
 *
 * The input is never mutated: a transcript is persisted state, and an in-place
 * shake would be impossible to undo.
 */
export function shake(messages: readonly Message[], config: ShakeConfig = DEFAULT_SHAKE_CONFIG): ShakeResult {
	const calls = collectToolCallsById(messages);
	const regions: ShakeRegion[] = [];
	collectBlockRegions(messages, config, calls, regions);
	if (regions.length === 0) return { messages: [...messages], shakenCount: 0, tokensSaved: 0 };

	// Group by message so each message is rebuilt once, in ascending order.
	const byMessage = new Map<number, ShakeRegion[]>();
	for (const region of regions) {
		if (!byMessage.has(region.messageIndex)) byMessage.set(region.messageIndex, []);
		byMessage.get(region.messageIndex)!.push(region);
	}

	// Recency protection and the cache guard, decided per message.
	const suffix = config.cacheWarmSuffixTokens === undefined ? undefined : computeMessageSuffixTokens(messages);
	let accumulated = 0;
	const eligible = new Set<number>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidates = byMessage.get(index);
		if (!candidates) continue;
		const inWarmPrefix =
			suffix !== undefined &&
			config.cacheWarmSuffixTokens !== undefined &&
			suffix[index]! > config.cacheWarmSuffixTokens;
		// A warm prefix is skipped *before* any decision. Without this continue the
		// message fell through to the eligibility mark below, so the guard computed a
		// decision and then ignored it - the block was shaken anyway, and the guard
		// was dead code that still looked like it worked.
		if (inWarmPrefix) {
			continue;
		}
		// Recency protection: the most recent `protectTokens` of block content is
		// left intact.
		if (accumulated < config.protectTokens) {
			accumulated += candidates.reduce((total, region) => total + region.tokens, 0);
			continue;
		}
		eligible.add(index);
		accumulated += candidates.reduce((total, region) => total + region.tokens, 0);
	}

	if (eligible.size === 0) return { messages: [...messages], shakenCount: 0, tokensSaved: 0 };

	let tokensSaved = 0;
	let shakenCount = 0;
	const output = messages.map((message, index) => {
		const candidates = byMessage.get(index);
		if (!candidates || !eligible.has(index)) return message;
		const replaceAll = (text: string): string => {
			let result = text;
			// Applied last-to-first so earlier offsets stay valid.
			for (const region of [...candidates].sort((a, b) => b.start - a.start)) {
				const placeholder = createPlaceholder(region.label, region.tokens);
				result = result.slice(0, region.start) + placeholder + result.slice(region.end);
				tokensSaved += Math.max(0, region.tokens - Math.ceil(placeholder.length / 4));
				shakenCount++;
			}
			return result;
		};
		if (message.role === "assistant") {
			const content = (message as AssistantMessage).content.map((block, blockIndex) =>
				block.type === "text" && byMessage.get(index)!.some((region) => region.blockIndex === blockIndex)
					? { ...block, text: replaceAll(block.text) }
					: block,
			);
			return { ...(message as AssistantMessage), content } as Message;
		}
		if (message.role === "toolResult") {
			const result = message as ToolResultMessage;
			return {
				...result,
				content: result.content.map((block, blockIndex) =>
					block.type === "text" && byMessage.get(index)!.some((region) => region.blockIndex === blockIndex)
						? { ...block, text: replaceAll(block.text) }
						: block,
				),
			} as Message;
		}
		return { ...message, content: replaceAll(contentText((message as { content: string }).content)) } as Message;
	});

	// Below the threshold nothing is rewritten at all: the churn is not worth it.
	if (tokensSaved < config.minSavings) return { messages: [...messages], shakenCount: 0, tokensSaved: 0 };
	return { messages: output, shakenCount, tokensSaved };
}
