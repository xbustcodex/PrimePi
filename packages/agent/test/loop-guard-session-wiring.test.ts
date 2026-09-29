import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CrossTurnLoopGuard } from "../src/loop-guards/cross-turn.ts";

/**
 * The session's wiring of the loop guard.
 *
 * The unit under test is the decision the session makes from a guard action, and
 * the property that matters is that the two branches are opposites: a redirect
 * must re-enter the loop, and an abort must not. A session that continues after an
 * abort burns the rest of its budget on a model that has already been told to
 * stop; one that returns false after a redirect leaves the corrective in history
 * with nothing to act on it.
 */

/** Mirrors AgentSession._evaluateToolCallLoopGuard for the two decisions it makes. */
function applySessionDecision(
	guard: CrossTurnLoopGuard,
	turn: { message: AssistantMessage; toolResults: ToolResultMessage[] },
	hooks: { appended: string[]; aborted: number },
): { continueTurn: boolean } {
	const action = guard.recordTurn(turn);
	if (action.action === "abort") {
		hooks.aborted++;
		return { continueTurn: false };
	}
	if (action.action === "redirect") {
		hooks.appended.push(String(action.message));
		return { continueTurn: true };
	}
	return { continueTurn: false };
}

const turn = (): { message: AssistantMessage; toolResults: ToolResultMessage[] } => ({
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
	} as unknown as AssistantMessage,
	toolResults: [
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [],
			isError: true,
		} as unknown as ToolResultMessage,
	],
});

const makeGuard = () =>
	new CrossTurnLoopGuard({
		name: "session",
		settings: { enabled: true, threshold: 3, exemptTools: [] },
		liveMessages: () => [],
		appendMessage: () => {},
		abort: () => {},
	});

describe("a redirect re-enters the loop", () => {
	it("continues the turn and records the corrective", () => {
		const guard = makeGuard();
		const hooks = { appended: [] as string[], aborted: 0 };
		let decision = { continueTurn: false };
		for (let i = 0; i < 3; i++) decision = applySessionDecision(guard, turn(), hooks);
		expect(decision.continueTurn).toBe(true);
		expect(hooks.appended).toHaveLength(1);
		expect(hooks.appended[0]).toContain("bash");
	});

	it("does not abort a turn it is redirecting", () => {
		const guard = makeGuard();
		const hooks = { appended: [] as string[], aborted: 0 };
		for (let i = 0; i < 3; i++) applySessionDecision(guard, turn(), hooks);
		expect(hooks.aborted).toBe(0);
	});
});

describe("an abort stops the turn", () => {
	it("does not continue", () => {
		// Continuing after an abort burns the rest of the budget on a model that has
		// already been told to stop.
		const guard = makeGuard();
		const hooks = { appended: [] as string[], aborted: 0 };
		for (let i = 0; i < 3; i++) applySessionDecision(guard, turn(), hooks);
		let decision = { continueTurn: true };
		for (let i = 0; i < 3; i++) decision = applySessionDecision(guard, turn(), hooks);
		expect(decision.continueTurn).toBe(false);
		expect(hooks.aborted).toBe(1);
	});

	it("does not also record a corrective", () => {
		const guard = makeGuard();
		const hooks = { appended: [] as string[], aborted: 0 };
		for (let i = 0; i < 6; i++) applySessionDecision(guard, turn(), hooks);
		expect(hooks.appended).toHaveLength(1);
	});
});

describe("a non-assistant turn is ignored", () => {
	it("does not act on a non-assistant message", () => {
		const guard = makeGuard();
		const hooks = { appended: [] as string[], aborted: 0 };
		const decision = applySessionDecision(
			guard,
			{ message: { role: "user", content: "hi" } as unknown as AssistantMessage, toolResults: [] },
			hooks,
		);
		expect(decision.continueTurn).toBe(false);
		expect(hooks.appended).toHaveLength(0);
	});
});
