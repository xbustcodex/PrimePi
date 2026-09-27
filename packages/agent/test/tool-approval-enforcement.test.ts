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
 * Approval enforcement at the real execution boundary.
 *
 * The approval unit tests prove the *decision* is right. This proves the decision
 * is *honoured* — that a denial prevents invocation rather than being recorded
 * alongside an execution that already happened.
 *
 * That distinction is the point. A gate that ran the tool and then reported
 * "denied" would satisfy any test that only inspects the returned error, and
 * would still leave a deleted file behind. So every test here counts real
 * invocations of the tool's `execute`.
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

function assistantWithToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rm -rf /" } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

/** A plain text reply, used to end the loop after the tool result is recorded. */
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
	return messages.filter(
		(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

/** Mirrors the gate the session installs, without importing the application layer. */
function approvalDecision(options: {
	mode: "always-ask" | "write" | "yolo";
	policies: Record<string, "allow" | "deny" | "prompt">;
	prompt?: () => Promise<"allow" | "deny">;
}): { block?: boolean; reason?: string } | undefined {
	if (options.policies.bash === "deny") {
		return { block: true, reason: `Tool "bash" is blocked by user policy.` };
	}
	// bash is exec, so only yolo auto-approves it.
	const needsPrompt = options.mode !== "yolo";
	if (!needsPrompt) return undefined;
	if (!options.prompt) {
		return { block: true, reason: `Tool "bash" requires approval but no interactive surface is available.` };
	}
	// The prompt is synchronous here only to keep the test shape simple; the real
	// gate awaits it, and the branch taken is the same.
	return undefined;
}

describe("a denied tool performs no side effects", () => {
	function bashTool(onExecute: () => void): AgentTool {
		return {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: Type.Object({ command: Type.String() }),
			async execute() {
				onExecute();
				return { content: [{ type: "text", text: "ran" }], details: undefined };
			},
		} as unknown as AgentTool;
	}

	async function runOnce(
		options: Parameters<typeof approvalDecision>[0],
		onExecute: () => void,
	): Promise<AgentEvent[]> {
		const events: AgentEvent[] = [];
		const tool = bashTool(onExecute);
		const context: AgentContext = { messages: [], tools: [tool] };

		await runAgentLoop(
			[userMessage("delete everything")] as AgentMessage[],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => approvalDecision(options),
			},
			async (event: AgentEvent) => {
				events.push(event);
			},
			undefined,
			// Turn-aware: the first response asks for the tool, and any later
			// response ends the loop. Without that, a persistent `toolUse` reply
			// would loop forever rather than exercising one call.
			((_model: unknown, context: { messages: Message[] }) => {
				const stream = new MockAssistantStream();
				const alreadyRan = context.messages.some((message) => message.role === "toolResult");
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: alreadyRan ? "stop" : "toolUse",
						message: alreadyRan ? assistantWithText("finished") : assistantWithToolCall(),
					});
				});
				return stream;
			}) as never,
		);
		return events;
	}

	it("never invokes the tool under a user deny", async () => {
		let executions = 0;
		const events = await runOnce({ mode: "yolo", policies: { bash: "deny" } }, () => executions++);

		// The property under test.
		expect(executions).toBe(0);

		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toBeDefined();
		expect(end && "isError" in end ? end.isError : null).toBe(true);
	});

	it("never invokes the tool when a required prompt cannot be asked", async () => {
		// Non-interactive: the question cannot be put to anyone, so the call is
		// refused rather than assumed safe.
		let executions = 0;
		await runOnce({ mode: "always-ask", policies: {} }, () => executions++);
		expect(executions).toBe(0);
	});

	it("never invokes the tool under write mode for an exec-tier call", async () => {
		let executions = 0;
		await runOnce({ mode: "write", policies: {} }, () => executions++);
		expect(executions).toBe(0);
	});

	it("invokes the tool under yolo with no policy", async () => {
		let executions = 0;
		await runOnce({ mode: "yolo", policies: {} }, () => executions++);
		expect(executions).toBe(1);
	});

	it("surfaces the denial reason to the model", async () => {
		let executions = 0;
		const events = await runOnce({ mode: "yolo", policies: { bash: "deny" } }, () => executions++);
		const end = events.find((event) => event.type === "tool_execution_end");
		const result = end && "result" in end ? end.result : undefined;
		const text = result?.content
			?.map((block: { type: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
			.join("");
		expect(text).toContain("blocked by user policy");
	});

	it("emits a start event even for a denied call, so the UI can close it out", async () => {
		let executions = 0;
		const events = await runOnce({ mode: "yolo", policies: { bash: "deny" } }, () => executions++);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(true);
	});
});
