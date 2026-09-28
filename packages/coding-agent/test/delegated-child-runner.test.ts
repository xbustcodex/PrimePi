import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * The delegated child loop, driven through a real session.
 *
 * Everything below the model call is the real implementation: the real task
 * tool, the real runner, and the real `_runDelegatedChild` loop in
 * `AgentSession`. Only the provider is stubbed, because a real turn needs
 * credentials the test environment does not have.
 *
 * What this catches that the module-level tests cannot: that a child can
 * actually *call a tool and act on the result*. A single-turn implementation
 * would pass every other delegation test and still be useless.
 */

interface AssistantReply {
	role: "assistant";
	content: { type: string; text?: string; id?: string; name?: string; arguments?: unknown }[];
}

/** A model runtime stub that replies with a scripted sequence. */
function stubRuntime(replies: AssistantReply[]) {
	const turns: unknown[][] = [];
	let index = 0;
	return {
		turns,
		hasConfiguredAuth: () => true,
		getAvailableSnapshot: () => [STUB_MODEL],
		async completeSimple(_model: unknown, messages: unknown[]) {
			turns.push(messages);
			const reply = replies[Math.min(index, replies.length - 1)];
			index++;
			return reply;
		},
		getModel: () => undefined,
		listModels: () => [],
		async dispose() {},
	};
}

// A real, eligible model, so role resolution has something to select.
const STUB_MODEL = {
	provider: "openrouter",
	id: "stub/model",
	name: "stub",
	api: "openai-completions",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const textReply = (text: string): AssistantReply => ({ role: "assistant", content: [{ type: "text", text }] });
const toolReply = (id: string, name: string, args: unknown): AssistantReply => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
});

async function withSession(
	runtime: ReturnType<typeof stubRuntime>,
	fn: (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => Promise<void>,
	cwd = mkdtempSync(join(tmpdir(), "pi-child-runner-")),
): Promise<void> {
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			modelRuntime: runtime as never,
			model: STUB_MODEL as never,
		});
		try {
			await fn(session);
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

/** Invokes the real `task` tool the way the agent runtime does. */
async function delegate(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"],
	params: Record<string, unknown>,
): Promise<{ text: string }> {
	const definition = session.getToolDefinition("task");
	if (!definition) throw new Error("task tool is not registered");
	const outcome = await definition.execute(
		"call-1",
		{ op: "run", agent: "coder", task: "do the work", ...params },
		new AbortController().signal,
		() => {},
		{} as never,
	);
	return { text: outcome.content.map((part) => ("text" in part ? part.text : "")).join("") };
}

describe("delegated child loop", () => {
	it("returns the child's answer when it needs no tools", async () => {
		const runtime = stubRuntime([textReply("the answer is 42")]);
		await withSession(runtime, async (session) => {
			const result = await delegate(session, {});
			expect(result.text).toBe("the answer is 42");
			expect(runtime.turns).toHaveLength(1);
		});
	});

	it("executes a granted tool and lets the child act on the result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-child-tool-"));
		writeFileSync(join(cwd, "target.txt"), "real contents");
		const runtime = stubRuntime([toolReply("call-1", "read", { path: "target.txt" }), textReply("I read it")]);

		await withSession(
			runtime,
			async (session) => {
				const result = await delegate(session, { tools: ["read"] });
				// The child's final answer, not its tool call.
				expect(result.text).toBe("I read it");
				// Two turns: the tool call, then the reply informed by it.
				expect(runtime.turns).toHaveLength(2);
				const second = runtime.turns[1] as { role: string; isError?: boolean }[];
				const toolResult = second.find((message) => message.role === "toolResult");
				expect(toolResult).toBeDefined();
				expect(toolResult?.isError).toBeFalsy();
			},
			cwd,
		);
	});

	it("refuses a tool the child was not granted, without running it", async () => {
		const runtime = stubRuntime([
			toolReply("call-1", "write", { path: "x.txt", content: "no" }),
			textReply("understood"),
		]);
		await withSession(runtime, async (session) => {
			// The child asks for a tool the parent's grant excludes.
			const result = await delegate(session, { tools: ["read"] });
			expect(result.text).toBe("understood");
			const second = runtime.turns[1] as { role: string; isError?: boolean; content: unknown }[];
			const toolResult = second.find((message) => message.role === "toolResult");
			expect(toolResult?.isError).toBe(true);
			expect(JSON.stringify(toolResult?.content)).toMatch(/not available/i);
		});
	});

	it("stops after the child's request budget is spent", async () => {
		// A child that keeps calling tools must still terminate. Without a bound
		// this is an unbounded loop against a real provider.
		const runtime = stubRuntime([toolReply("call-1", "read", { path: "missing.txt" })]);
		await withSession(runtime, async (session) => {
			const result = await delegate(session, { tools: ["read"] });
			// A failure is a legitimate outcome; what matters is that it terminated.
			expect(result.text).toBeDefined();
			expect(runtime.turns.length).toBeLessThanOrEqual(201);
			expect(runtime.turns.length).toBeGreaterThan(0);
		});
	});
});
