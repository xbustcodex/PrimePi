import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createPlaceholder,
	DEFAULT_SHAKE_CONFIG,
	scanTextForBlockRanges,
	shake,
} from "../src/harness/compaction/shake.ts";

/**
 * "Shake": surgical context reduction.
 *
 * The cases that matter most are the ones where a naive implementation loses
 * content: an unterminated fence, a mismatched XML tag, a block inside a warm
 * cache prefix. A placeholder that does not describe what it replaced is worse
 * than the tokens it saved, because the model has no way to recover them.
 */

let counter = 0;
function call(name: string, args: Record<string, unknown> = {}) {
	return { id: `c${++counter}`, name, args };
}
function assistant(callLike: { id: string; name: string; args: Record<string, unknown> }, text: string): Message {
	return {
		role: "assistant",
		content: [
			{ type: "toolCall", id: callLike.id, name: callLike.name, arguments: callLike.args },
			{ type: "text", text },
		],
		timestamp: 1,
	} as Message;
}
function toolResult(callLike: { id: string; name: string }, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: callLike.id,
		toolName: callLike.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as Message;
}

// Fence markers, as named constants. A template literal containing backticks
// is not parseable, and the fences are the subject under test.
const FENCE_OPEN = "\u0060\u0060\u0060";
const FENCE_CLOSE = FENCE_OPEN;

/** A fenced block of `lines` lines, wrapped in a line of prose on each side. */
function fenced(lines: number): string {
	const body = Array.from({ length: lines }, (_, index) => `\tconst value${index} = compute(${index});`);
	return [
		"Here is the relevant output.",
		FENCE_OPEN + "ts",
		...body,
		FENCE_CLOSE,
		"Nothing else depends on those lines.",
	].join("\n");
}

const open = { ...DEFAULT_SHAKE_CONFIG, protectTokens: 0, minSavings: 0 };

describe("block detection is conservative", () => {
	it("finds a fenced block, including its fence lines", () => {
		const text = "before\n```ts\nconst a = 1;\n```\nafter";
		const ranges = scanTextForBlockRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe("```ts\nconst a = 1;\n```");
	});

	it("finds a top-level XML element", () => {
		const text = "before\n<diff>\nline one\nline two\n</diff>\nafter";
		const ranges = scanTextForBlockRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe("<diff>\nline one\nline two\n</diff>");
	});

	it("yields nothing for an unterminated fence", () => {
		// Half-detecting a block would replace it with a placeholder describing
		// content that is still there - strictly worse than leaving the tokens.
		expect(scanTextForBlockRanges("before\n```ts\nconst a = 1;\n")).toEqual([]);
	});

	it("yields nothing for an unterminated tag", () => {
		expect(scanTextForBlockRanges("before\n<diff>\nline one\n")).toEqual([]);
	});

	it("does not close a tag with the wrong name", () => {
		// `<a><b></a>` must not produce a span ending before its own content.
		expect(scanTextForBlockRanges("<a>\n<b>\nx\n</a>\n")).toEqual([]);
	});

	it("suppresses XML detection inside a fence", () => {
		// A fenced block containing XML yields one span, not two overlapping ones.
		const ranges = scanTextForBlockRanges("```\n<diff>\nx\n</diff>\n```");
		expect(ranges).toHaveLength(1);
	});

	it("finds several blocks and keeps them separate", () => {
		const text = "```\na\n```\nbetween\n```\nc\n```";
		expect(scanTextForBlockRanges(text)).toHaveLength(2);
	});
});

describe("shake replaces a block and keeps the prose", () => {
	it("keeps the surrounding explanation", () => {
		const c = call("read", { path: "a.ts" });
		// A block large enough to clear the default `fenceMinTokens` of 64, because a
		// small one is correctly left alone - replacing it with a placeholder would
		// cost more than it saves.
		const body = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join("\n");
		const text = ["The build failed. Here is the log.", FENCE_OPEN, body, FENCE_CLOSE, "That is all of it."].join(
			"\n",
		);
		const result = shake([assistant(c, text), toolResult(c, "ok")], open);
		expect(result.shakenCount).toBe(1);
		const assistantMessage = result.messages[0] as { content: { type: string; text?: string }[] };
		const shaken = assistantMessage.content.find((block) => block.type === "text")!.text!;
		// The whole point of shake over pruning: the prose survives, because it is
		// the part that explains what the block was.
		expect(shaken).toContain("The build failed.");
		expect(shaken).toContain("That is all of it.");
		expect(shaken).not.toContain("log line 0");
	});

	it("leaves a block too small for its placeholder alone", () => {
		const c = call("read", {});
		const text = "intro\n```\nx\n```\noutro";
		const result = shake([assistant(c, text), toolResult(c, "ok")], open);
		// Replacing four tokens with a sixteen-token placeholder is a loss.
		expect(result.shakenCount).toBe(0);
	});

	it("never mutates the input", () => {
		const c = call("read", {});
		const messages = [assistant(c, fenced(40)), toolResult(c, "ok")];
		const before = JSON.stringify(messages);
		shake(messages, open);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("reclaims a large block from a tool result", () => {
		const c = call("bash", { command: "npm test" });
		const messages = [assistant(c, "running"), toolResult(c, fenced(60))];
		const result = shake(messages, open);
		expect(result.shakenCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});
});

describe("shake shares pruning's protections", () => {
	it("protects a skill read", () => {
		// Eliding a skill read would make the model re-read it, and the re-read
		// would be elided too.
		const c = call("read", { path: "skill://python/testing" });
		const messages = [assistant(c, "loading"), toolResult(c, fenced(60))];
		const result = shake(messages, {
			...open,
			protectedTools: [({ toolCall }) => toolCall?.arguments.path?.toString().startsWith("skill://") ?? false],
		});
		expect(result.shakenCount).toBe(0);
	});

	it("never shakes a result the tool flags as an image", () => {
		// An image has no text to elide; dropping its block would lose the only
		// content the result carries.
		const c = call("image_read", {});
		const message: Message = {
			role: "toolResult",
			toolCallId: c.id,
			toolName: "image_read",
			content: [
				{ type: "text", text: fenced(60) },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		} as unknown as Message;
		const result = shake([assistant(c, "looking"), message], open);
		expect(result.shakenCount).toBe(0);
	});
});

describe("the warm prompt-cache prefix is never rewritten", () => {
	it("leaves a deep block alone when its suffix exceeds the guard", () => {
		// Mutating a cached message re-writes everything after it at the
		// cache-write price, which can cost more than the saving.
		const c = call("bash", {});
		const messages: Message[] = [];
		for (let index = 0; index < 6; index++) {
			const each = call("bash", {});
			messages.push(assistant(each, "step"), toolResult(each, fenced(60)));
		}
		const guarded = shake(messages, { ...open, protectTokens: 0, cacheWarmSuffixTokens: 1 });
		const unguarded = shake(messages, open);
		// A difference, not an invented absolute: the guard is what makes the
		// difference, and the newest message's suffix is empty so it is never cached.
		expect(guarded.shakenCount).toBeLessThan(unguarded.shakenCount);
	});

	it("shakes normally when the guard is generous", () => {
		const c = call("bash", {});
		const result = shake([assistant(c, "step"), toolResult(c, fenced(60))], {
			...open,
			cacheWarmSuffixTokens: 100_000_000,
		});
		expect(result.shakenCount).toBe(1);
	});
});

describe("recency protection", () => {
	it("leaves recent context intact", () => {
		const c = call("bash", {});
		const result = shake([assistant(c, "step"), toolResult(c, fenced(60))], {
			...open,
			protectTokens: 100_000,
		});
		expect(result.shakenCount).toBe(0);
	});
});

describe("the minimum-savings rule", () => {
	it("changes nothing when the saving is below the threshold", () => {
		const c = call("bash", {});
		const messages = [assistant(c, "step"), toolResult(c, fenced(40))];
		const result = shake(messages, { ...open, minSavings: 100_000_000 });
		// Rewriting the prompt and busting the cache to save almost nothing is a
		// net loss, so nothing is rewritten at all.
		expect(result.shakenCount).toBe(0);
		expect(result.messages).toEqual(messages);
	});
});

describe("placeholders", () => {
	it("names the source and the size, so the loss is legible", () => {
		const placeholder = createPlaceholder("bash", 1234);
		expect(placeholder).toContain("bash");
		expect(placeholder).toContain("1234");
		expect(placeholder).toContain("elided");
	});
});
