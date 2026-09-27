import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * The planning barrier proven at the real execution boundary.
 *
 * The decision-level tests show the barrier returns a denial. This file shows what
 * that denial *does*: the tool's `execute` is never reached, so the underlying
 * write or process never happens.
 *
 * That distinction is the whole point. A barrier implemented inside a tool would
 * pass every decision-level test and still leave a deleted file behind, because
 * the tool would already be running. Here the counting is of real invocations.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
	push(event: AssistantMessageEvent): void {
		queueMicrotask(() => super.push(event));
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantWithToolCall(name: string, args: Record<string, string>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function assistantWithText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role !== "custom") as Message[];
}

describe("a tool denied by the planning barrier performs no side effect", () => {
	/** Records every `execute`, which is what a side effect would show up as. */
	function countingTool(name: string, onExecute: () => void): AgentTool {
		return {
			name,
			label: name,
			description: "test tool",
			parameters: Type.Object({ path: Type.Optional(Type.String()), command: Type.Optional(Type.String()) }),
			async execute() {
				onExecute();
				return { content: [{ type: "text", text: "ran" }], details: undefined };
			},
		} as unknown as AgentTool;
	}

	async function runOnce(
		toolName: string,
		args: Record<string, string>,
		barrierDecision: { block: boolean; reason?: string } | undefined,
		onExecute: () => void,
	): Promise<AgentEvent[]> {
		const events: AgentEvent[] = [];
		const tool = countingTool(toolName, onExecute);
		const context: AgentContext = { messages: [], tools: [tool] };

		await runAgentLoop(
			[userMessage("do the thing")] as AgentMessage[],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				// Stands in for the session's gate: approval and planning barrier
				// combined, evaluated before `execute`.
				beforeToolCall: async () => barrierDecision,
			},
			async (event: AgentEvent) => {
				events.push(event);
			},
			undefined,
			((_model: unknown, ctx: { messages: Message[] }) => {
				const stream = new MockAssistantStream();
				const alreadyRan = ctx.messages.some((message) => message.role === "toolResult");
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: alreadyRan ? "stop" : "toolUse",
						message: alreadyRan ? assistantWithText("done") : assistantWithToolCall(toolName, args),
					});
				});
				return stream;
			}) as never,
		);
		return events;
	}

	it("never runs a write the barrier denied", async () => {
		let executions = 0;
		const events = await runOnce(
			"write",
			{ path: "src/index.ts" },
			{ block: true, reason: "Plan mode: read-only" },
			() => executions++,
		);

		// The property: the tool body never ran.
		expect(executions).toBe(0);

		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toBeDefined();
		expect(end && "isError" in end ? end.isError : null).toBe(true);
	});

	it("never runs a shell command the barrier denied", async () => {
		// The specific gap in OMP, where `bash` is unrestricted during planning.
		let executions = 0;
		await runOnce(
			"bash",
			{ command: "rm -rf /" },
			{ block: true, reason: "Plan mode: read-only" },
			() => executions++,
		);
		expect(executions).toBe(0);
	});

	it("runs the tool when the barrier is down", async () => {
		// The control: proving the gate, not the harness, is what prevents
		// execution. Without this, a broken barrier would look identical.
		let executions = 0;
		await runOnce("write", { path: "src/index.ts" }, undefined, () => executions++);
		expect(executions).toBe(1);
	});

	it("reports the denial reason to the model", async () => {
		const events = await runOnce(
			"write",
			{ path: "src/index.ts" },
			{ block: true, reason: "Plan mode: the working tree is read-only while planning." },
			() => {},
		);
		const end = events.find((event) => event.type === "tool_execution_end");
		const result = end && "result" in end ? end.result : undefined;
		const text = result?.content
			?.map((block: { type: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
			.join("");
		expect(text).toContain("read-only");
	});
});
