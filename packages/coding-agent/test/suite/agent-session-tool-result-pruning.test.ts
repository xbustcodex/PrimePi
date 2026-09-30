import { MIN_PRUNE_TOKENS } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Message,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/**
 * Tool-result pruning, driven through `AgentSession`.
 *
 * Every case changes a `compaction.*` setting or a transcript and reads back
 * what the next request would carry. The assertion is always on the projected
 * messages the provider is about to see, because a prune that is not in the
 * projection is not a prune.
 */

type SessionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage) => Promise<boolean>;
};

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(harness: Harness, text: string, timestamp: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text, { timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(0),
	};
}

interface ReadTurn {
	path: string;
	offset?: number;
	limit?: number;
	result: string;
	details?: unknown;
}

/**
 * Appends one assistant turn that issues `read` calls, plus their results.
 *
 * Uses the session's own `appendMessage` so the entries are persisted exactly
 * as a real turn's would be; the prune reads the same projection the next
 * request does.
 */
let nextTurn = 0;
/** Deep enough that even a long transcript stays ordered behind the user turn. */
const MAX_TURNS = 40;

function appendReadTurn(
	harness: Harness,
	reads: ReadTurn[],
	details?: (read: ReadTurn) => unknown,
): { assistantEntryId: string; resultEntryIds: string[] } {
	// A monotonic counter, not `Date.now()`: two turns seeded in the same
	// millisecond would otherwise mint identical tool-call ids, and a result is
	// paired to its call by id.
	const turn = nextTurn++;
	let clock = Date.now() - (MAX_TURNS - turn) * 1_000;
	const toolCalls = reads.map((read, index) => ({
		type: "toolCall" as const,
		id: `call-${turn}-${index}`,
		name: "read",
		arguments: {
			path: read.path,
			...(read.offset === undefined ? {} : { offset: read.offset }),
			...(read.limit === undefined ? {} : { limit: read.limit }),
		},
	}));
	const assistantEntryId = harness.sessionManager.appendMessage({
		...assistant(harness, "reading", clock++),
		content: toolCalls,
	} as AssistantMessage);
	const resultEntryIds: string[] = [];
	for (const [index, read] of reads.entries()) {
		resultEntryIds.push(
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: toolCalls[index]!.id,
				toolName: "read",
				content: [{ type: "text", text: read.result }],
				isError: false,
				timestamp: clock++,
				...(details ? { details: details(read) } : {}),
			} as unknown as Message),
		);
	}
	return { assistantEntryId, resultEntryIds };
}

/** Text of every projected tool result, in order. */
function projectedToolResults(harness: Harness): string[] {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.filter((message) => message.role === "toolResult")
		.map((message) => getMessageText(message));
}

function withInternals(harness: Harness): SessionInternals {
	return harness.session as unknown as SessionInternals;
}

describe("tool-result pruning", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function pruneNow(harness: Harness): Promise<boolean> {
		const assistantEntryId = harness.sessionManager.getEntries().at(-1);
		void assistantEntryId;
		return await withInternals(harness)._checkCompaction(assistant(harness, "done", Date.now()));
	}

	it("replaces a read a newer read of the same path superseded, and keeps the newest copy", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [
			{ path: "src/a.ts", result: `old contents ${"a".repeat(400)}` },
			{ path: "src/b.ts", result: `unrelated ${"b".repeat(400)}` },
		]);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `new contents ${"c".repeat(400)}` }]);

		expect(projectedToolResults(harness)).toHaveLength(3);
		await pruneNow(harness);

		const after = projectedToolResults(harness);
		// The stale a.ts read is gone; the current one, and the read of a
		// different path, are untouched.
		expect(after[0]).toContain("[Superseded by a newer read of this file]");
		expect(after[1]).toContain("unrelated");
		expect(after[2]).toContain("new contents");
		// A read of a different path is not superseded by anything.
		expect(after[1]).not.toContain("[Superseded");
		// The newest copy of a.ts is the only record of the current file and
		// must survive.
		expect(after.filter((text) => text.includes("Superseded"))).toHaveLength(1);
	});

	it("replaces an uninformative result with the uneventful notice", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "search" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [
			// Whitespace-only: carries no information, and large enough that
			// replacing it with a short notice is a net saving. A result that was
			// empty *and* tiny would correctly be left alone — the notice would
			// cost more than the content.
			{ path: "src/blank.ts", result: " ".repeat(200) },
			{ path: "src/real.ts", result: `real contents ${"d".repeat(400)}` },
		]);

		await pruneNow(harness);

		const after = projectedToolResults(harness);
		expect(after[0]).toBe("[Uneventful result elided]");
		expect(after[1]).toContain("real contents");
	});

	it("drops nothing when both settings are off, and prunes when they are on", async () => {
		const seed = async (settings: { supersedeReads: boolean; dropUseless: boolean }) => {
			const harness = await createHarness({
				settings: {
					compaction: {
						supersedeReads: settings.supersedeReads,
						dropUseless: settings.dropUseless,
					},
				},
			} as never);
			harnesses.push(harness);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "read it" }],
				timestamp: Date.now() - 30_000,
			});
			appendReadTurn(harness, [
				{ path: "src/a.ts", result: `old ${"a".repeat(400)}` },
				{ path: "src/blank.ts", result: " ".repeat(200) },
			]);
			appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);
			return harness;
		};

		const off = await seed({ supersedeReads: false, dropUseless: false });
		await pruneNow(off);
		expect(projectedToolResults(off)).toHaveLength(3);
		expect(projectedToolResults(off).some((text) => text.includes("Superseded"))).toBe(false);
		expect(projectedToolResults(off).some((text) => text.includes("Uneventful"))).toBe(false);

		const on = await seed({ supersedeReads: true, dropUseless: true });
		await pruneNow(on);
		expect(projectedToolResults(on).filter((text) => text.includes("Superseded"))).toHaveLength(1);
		expect(projectedToolResults(on).filter((text) => text.includes("Uneventful"))).toHaveLength(1);
	});

	it("prunes supersede but not uneventful when only supersedeReads is on", async () => {
		const harness = await createHarness({
			settings: { compaction: { supersedeReads: true, dropUseless: false } },
		} as never);
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [
			{ path: "src/a.ts", result: `old ${"a".repeat(400)}` },
			{ path: "src/blank.ts", result: " ".repeat(200) },
		]);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);

		await pruneNow(harness);

		const after = projectedToolResults(harness);
		expect(after.filter((text) => text.includes("Superseded"))).toHaveLength(1);
		// The blank result keeps its body: with the rule off, it is still the
		// record that the call happened and returned nothing.
		expect(after[1]).toBe(" ".repeat(200));
	});

	it("keeps an artifact recovery result even when a newer read superseded its key", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "recover" }],
			timestamp: Date.now() - 30_000,
		});
		// The call reads an ordinary path, but the result declares an internal
		// artifact source: eliding it would mint a replacement read.
		appendReadTurn(
			harness,
			[
				{ path: "src/a.ts", result: `artifact page ${"e".repeat(400)}` },
				{ path: "src/blank.ts", result: "" },
			],
			(read) => ({ meta: { source: { type: "internal", value: `artifact://${read.path}` } } }),
		);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);

		await pruneNow(harness);

		const after = projectedToolResults(harness);
		expect(after[0]).toContain("artifact page");
		expect(after[0]).not.toContain("Superseded");
	});

	it("does not supersede a whole-file read with a narrower re-read of the same path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [{ path: "src/a.ts", result: `whole file ${"f".repeat(400)}` }]);
		// A later partial read of the same file is NOT strictly newer
		// information: it cannot replace the whole-file record.
		appendReadTurn(harness, [{ path: "src/a.ts", offset: 1, limit: 20, result: `just the top ${"q".repeat(400)}` }]);

		await pruneNow(harness);

		const after = projectedToolResults(harness);
		expect(after[0]).toContain("whole file");
		expect(after.some((text) => text.includes("Superseded"))).toBe(false);
	});

	it("supersedes a partial read when a later whole-file read covers it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [{ path: "src/a.ts", offset: 1, limit: 20, result: `just the top ${"q".repeat(400)}` }]);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `whole file ${"g".repeat(400)}` }]);

		await pruneNow(harness);

		const after = projectedToolResults(harness);
		expect(after[0]).toContain("[Superseded by a newer read of this file]");
		expect(after[1]).toContain("whole file");
	});

	it("leaves a superseded result too small to pay for its own notice intact", async () => {
		// The notice is longer than a few tokens of content, so replacing a tiny
		// result would grow the context and bust the prompt cache to save
		// nothing. The floor is what makes "prune it anyway" the wrong move.
		const seed = async (body: string) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "read it" }],
				timestamp: Date.now() - 30_000,
			});
			appendReadTurn(harness, [{ path: "src/a.ts", result: body }]);
			appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);
			await pruneNow(harness);
			return harness;
		};

		// Below the floor: the notice would cost more than the content it
		// replaces, so the stale copy stays.
		const tiny = await seed("x".repeat(8));
		expect(projectedToolResults(tiny)[0]).toBe("x".repeat(8));

		// Above the floor: the same relationship, now a real saving.
		const large = await seed("x".repeat(400));
		expect(projectedToolResults(large)[0]).toContain("[Superseded by a newer read of this file]");

		expect(MIN_PRUNE_TOKENS).toBeGreaterThan(0);
	});

	it("does not stack duplicate edits across repeated passes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [{ path: "src/a.ts", result: `old ${"a".repeat(400)}` }]);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);

		await pruneNow(harness);
		const editCountAfterFirst = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "context_edit").length;
		expect(editCountAfterFirst).toBe(1);

		await pruneNow(harness);
		const editCountAfterSecond = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "context_edit").length;
		expect(editCountAfterSecond).toBe(editCountAfterFirst);
	});

	it("prunes again after a later read supersedes a previously-protected result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		// No newer read yet: b.ts is the only record and must survive.
		appendReadTurn(harness, [{ path: "src/b.ts", result: `only copy ${"h".repeat(400)}` }]);
		await pruneNow(harness);
		expect(projectedToolResults(harness)[0]).toContain("only copy");

		// A later read of the same path makes the first one redundant.
		appendReadTurn(harness, [{ path: "src/b.ts", result: `second copy ${"i".repeat(400)}` }]);
		await pruneNow(harness);
		const after = projectedToolResults(harness);
		expect(after[0]).toContain("[Superseded by a newer read of this file]");
		expect(after[1]).toContain("second copy");
	});

	it("carries the notice into the next provider request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read it" }],
			timestamp: Date.now() - 30_000,
		});
		appendReadTurn(harness, [{ path: "src/a.ts", result: `old ${"a".repeat(400)}` }]);
		appendReadTurn(harness, [{ path: "src/a.ts", result: `new ${"c".repeat(400)}` }]);
		await pruneNow(harness);

		// The value is only real if it leaves the machine. Capture the transcript
		// the next request is built from.
		let sent: string[] = [];
		harness.session.agent.streamFunction = (_model, context) => {
			sent = context.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: { ...fauxAssistantMessage("ok"), usage: usage(1) } as AssistantMessage,
				});
			});
			return stream;
		};
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("and now?");

		expect(sent.filter((text) => text.includes("Superseded"))).toHaveLength(1);
		expect(sent.some((text) => text.includes("new "))).toBe(true);
	});
});
