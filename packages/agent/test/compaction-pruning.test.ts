import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { MarkedToolResult } from "../src/harness/compaction/pruning.ts";
import {
	collectToolCallsById,
	DEFAULT_PRUNE_CONFIG,
	estimatePrunedSavings,
	isArtifactRecoveryResult,
	isProtectedToolResult,
	isSkillReadResult,
	MIN_PRUNE_TOKENS,
	pruneToolOutputs,
	SUPERSEDED_NOTICE,
	USELESS_NOTICE,
} from "../src/harness/compaction/pruning.ts";

/**
 * Tool-output pruning.
 *
 * Every case writes into a synthetic transcript and reads the result back,
 * because the properties that matter - what was protected, what was replaced,
 * what the input looked like afterwards - only exist at the array boundary.
 */

let callCounter = 0;

function toolCall(name: string, args: Record<string, unknown> = {}) {
	const id = `call-${++callCounter}`;
	return { id, name, args };
}

function assistantWith(call: { id: string; name: string; args: Record<string, unknown> }): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }],
		timestamp: Date.now(),
	} as Message;
}

function toolResult(call: { id: string; name: string }, text: string, extra: Partial<ToolResultMessage> = {}): Message {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	} as Message;
}

/** A transcript of `count` read results of `size` characters each. */
function transcriptOfReads(count: number, size: number): { messages: Message[]; calls: ReturnType<typeof toolCall>[] } {
	const messages: Message[] = [];
	const calls: ReturnType<typeof toolCall>[] = [];
	for (let index = 0; index < count; index++) {
		const call = toolCall("read", { path: `file-${index}.ts` });
		calls.push(call);
		messages.push(assistantWith(call), toolResult(call, "x".repeat(size)));
	}
	return { messages, calls };
}

/** Config that makes age-based pruning actually fire on a small transcript. */
const aggressive = { ...DEFAULT_PRUNE_CONFIG, protectTokens: 0, minimumSavings: 0 };

describe("protection rules", () => {
	it("protects a read of a skill's internal url", () => {
		const call = toolCall("read", { path: "skill://python/testing" });
		const result = toolResult(call, "content") as ToolResultMessage;
		expect(isSkillReadResult({ toolResult: result, toolCall: { ...call, arguments: call.args } })).toBe(true);
		expect(isSkillReadResult({ toolResult: result, toolCall: undefined })).toBe(false);
	});

	it("protects an artifact recovery read, because eliding one mints another", () => {
		const call = toolCall("read", { path: "artifact://abc/page:10-20" });
		const result = toolResult(call, "content") as ToolResultMessage;
		expect(isArtifactRecoveryResult({ toolResult: result, toolCall: { ...call, arguments: call.args } })).toBe(true);
	});

	it("protects an artifact recovery whose result declares an internal source", () => {
		// The result carries the source rather than the call carrying the path, so
		// the rule has to check both halves.
		const result = toolResult(toolCall("read", {}), "content", {
			details: { meta: { source: { type: "internal", value: "artifact://xyz" } } },
		} as Partial<ToolResultMessage>) as ToolResultMessage;
		expect(isArtifactRecoveryResult({ toolResult: result, toolCall: undefined })).toBe(true);
	});

	it("protects every result of a tool named by a string matcher", () => {
		const call = toolCall("bash", { command: "ls" });
		const result = toolResult(call, "output") as ToolResultMessage;
		expect(isProtectedToolResult(result, { ...call, arguments: call.args }, ["skill"])).toBe(false);
		expect(isProtectedToolResult(result, { ...call, arguments: call.args }, ["bash"])).toBe(true);
	});

	it("indexes tool calls by id for pairing with their results", () => {
		const call = toolCall("read", { path: "a.ts" });
		const calls = collectToolCallsById([assistantWith(call), toolResult(call, "x")]);
		expect(calls.get(call.id)?.arguments.path).toBe("a.ts");
	});
});

describe("age-based protection", () => {
	it("leaves the most recent output intact", () => {
		// A model mid-investigation needs what it just fetched; pruning it turns a
		// follow-up question into a re-fetch.
		const { messages } = transcriptOfReads(6, 4000);
		const protectedConfig = { ...aggressive, protectTokens: 100_000, minimumSavings: 0 };
		const result = pruneToolOutputs(messages, protectedConfig);
		expect(result.prunedCount).toBe(0);
	});

	it("prunes older output once the protected budget is exceeded", () => {
		const { messages } = transcriptOfReads(10, 4000);
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 4_000 });
		expect(result.prunedCount).toBeGreaterThan(0);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});

	it("never mutates the input transcript", () => {
		// Persisted state: a prune that mutated in place would be impossible to undo
		// and impossible to test against the original.
		const { messages } = transcriptOfReads(10, 4000);
		const before = JSON.stringify(messages);
		pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000 });
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("does not prune a result too small for its notice to pay for itself", () => {
		// Eliding a four-token result in favour of an eight-token notice costs
		// tokens rather than saving them.
		const call = toolCall("read", { path: "tiny.ts" });
		const messages: Message[] = [assistantWith(call), toolResult(call, "hi")];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 0, minimumSavings: 0 });
		expect(result.prunedCount).toBe(0);
		expect(MIN_PRUNE_TOKENS).toBeGreaterThan(0);
	});

	it("does nothing when the saving falls under the minimum", () => {
		// Rewriting the prompt and busting the cache to save almost nothing is a
		// net loss.
		const { messages } = transcriptOfReads(4, 100);
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 0, minimumSavings: 1_000_000 });
		expect(result.prunedCount).toBe(0);
	});
});

describe("superseded results bypass the protection window", () => {
	const supersedeKey = (name: string, args: Record<string, unknown>) =>
		name === "read" && typeof args.path === "string" ? `read:${args.path}` : undefined;

	it("replaces an older read of the same file, even inside the window", () => {
		// A stale re-read is dead weight at any age, and protecting it would make
		// the least informative results the most expensive.
		const first = toolCall("read", { path: "src/index.ts" });
		const second = toolCall("read", { path: "src/index.ts" });
		const messages: Message[] = [
			assistantWith(first),
			toolResult(first, "old content ".repeat(50)),
			assistantWith(second),
			toolResult(second, "new content ".repeat(50)),
		];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, supersedeKey });
		expect(result.prunedCount).toBe(1);
		const pruned = result.messages[1] as MarkedToolResult;
		expect(pruned.prunedAt).toBeDefined();
	});

	it("keeps the newest read of a file", () => {
		const first = toolCall("read", { path: "a.ts" });
		const second = toolCall("read", { path: "a.ts" });
		const messages: Message[] = [
			assistantWith(first),
			toolResult(first, "old ".repeat(80)),
			assistantWith(second),
			toolResult(second, "new ".repeat(80)),
		];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, supersedeKey });
		const last = result.messages[3] as MarkedToolResult;
		// Pruning the newest would leave the session with no copy of the file at
		// all, which is worse than keeping the stale one.
		expect(last.prunedAt).toBeUndefined();
	});

	it("does not prune the same result twice on a second pass", () => {
		const first = toolCall("read", { path: "b.ts" });
		const second = toolCall("read", { path: "b.ts" });
		const messages: Message[] = [
			assistantWith(first),
			toolResult(first, "old ".repeat(80)),
			assistantWith(second),
			toolResult(second, "new ".repeat(80)),
		];
		const once = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, supersedeKey });
		const twice = pruneToolOutputs(once.messages, { ...aggressive, protectTokens: 1_000_000, supersedeKey });
		expect(once.prunedCount).toBe(1);
		expect(twice.prunedCount).toBe(0);
	});
});

describe("uneventful results", () => {
	it("elides a result that carries nothing", () => {
		const call = toolCall("grep", { pattern: "xyz" });
		// Long enough that the notice is genuinely smaller: a two-token result would
		// cost more to elide than to keep.
		const messages: Message[] = [assistantWith(call), toolResult(call, "   ".repeat(20))];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, pruneUseless: true });
		expect(result.prunedCount).toBe(1);
		const pruned = result.messages[1] as ToolResultMessage;
		expect(pruned.content).toEqual([{ type: "text", text: USELESS_NOTICE }]);
	});

	it("never elides an error, however short", () => {
		// "Command not found" is the single most informative thing a failed call
		// can say, and eliding it is how a model loops on the same failure.
		const call = toolCall("bash", { command: "nope" });
		const messages: Message[] = [assistantWith(call), toolResult(call, "no", { isError: true })];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, pruneUseless: true });
		expect(result.prunedCount).toBe(0);
	});

	it("can be turned off", () => {
		const call = toolCall("grep", { pattern: "xyz" });
		const messages: Message[] = [assistantWith(call), toolResult(call, "")];
		const result = pruneToolOutputs(messages, { ...aggressive, protectTokens: 1_000_000, pruneUseless: false });
		expect(result.prunedCount).toBe(0);
	});
});

describe("the warm prompt-cache prefix is never rewritten", () => {
	it("leaves a deep result alone when its suffix exceeds the guard", () => {
		// Mutating a cached message forces the provider to re-write everything after
		// it at the cache-write price, which can cost more than the pruning saves.
		const { messages } = transcriptOfReads(8, 4000);
		const guarded = pruneToolOutputs(messages, {
			...aggressive,
			protectTokens: 0,
			// A tiny guard, so every result but the last sits in the warm prefix.
			cacheWarmSuffixTokens: 1,
		});
		const unguarded = pruneToolOutputs(messages, { ...aggressive, protectTokens: 0 });
		// The guard is what makes the difference, and the one result it never blocks
		// is the last, whose suffix is empty by definition and therefore not cached.
		expect(guarded.prunedCount).toBeLessThan(unguarded.prunedCount);
		expect(guarded.prunedCount).toBe(1);
	});

	it("prunes normally when the guard is generous", () => {
		const { messages } = transcriptOfReads(8, 4000);
		const result = pruneToolOutputs(messages, {
			...aggressive,
			protectTokens: 0,
			cacheWarmSuffixTokens: 10_000_000,
		});
		expect(result.prunedCount).toBeGreaterThan(0);
	});
});

describe("savings are real", () => {
	it("reports a saving equal to the replaced tokens minus the notice", () => {
		expect(estimatePrunedSavings(100, "[x]")).toBe(100 - Math.ceil(3 / 4));
		// A notice longer than the content is a cost, and a caller checking this
		// can refuse the prune.
		expect(estimatePrunedSavings(2, SUPERSEDED_NOTICE)).toBeLessThan(0);
	});
});
