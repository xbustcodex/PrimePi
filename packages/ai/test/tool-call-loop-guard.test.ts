import { describe, expect, it } from "vitest";
import type { AssistantMessage, JsonObject, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { ToolCallLoopGuard } from "../src/utils/tool-call-loop-guard.ts";

/**
 * Tool-call loop guard.
 *
 * The cases that matter are the ones where detection must NOT fire, because a
 * guard that cries wolf gets disabled and then protects nothing. A model trying
 * variations is exploring; a model reissuing the identical call is stuck.
 */

let counter = 0;
function turn(calls: { name: string; args?: JsonObject }[], results: string[] = []): {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
} {
	counter += 1;
	const toolCalls: ToolCall[] = calls.map((call, index) => ({
		type: "toolCall",
		id: `c${counter}-${index}`,
		name: call.name,
		arguments: (call.args ?? {}) as JsonObject,
	}));
	const message = {
		role: "assistant",
		content: toolCalls,
		stopReason: "toolUse",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: counter,
	} as unknown as AssistantMessage;
	const toolResults: ToolResultMessage[] = toolCalls.map((call, index) => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: results[index] ?? `result ${index}` }],
		isError: true,
		timestamp: counter,
	})) as ToolResultMessage[];
	return { message, toolResults };
}

const guard = (threshold = 3, exemptTools: string[] = []) => new ToolCallLoopGuard({ threshold, exemptTools });

describe("a repeated identical call is detected", () => {
	it("fires once the threshold is reached", () => {
		const g = guard(3);
		const t = () => turn([{ name: "bash", args: { command: "npm test" } }]);
		expect(g.recordTurn(t())).toBeNull();
		expect(g.recordTurn(t())).toBeNull();
		const detection = g.recordTurn(t());
		expect(detection).not.toBeNull();
		expect(detection!.toolName).toBe("bash");
		expect(detection!.count).toBe(3);
	});

	it("does not fire below the threshold", () => {
		const g = guard(5);
		const t = () => turn([{ name: "bash", args: { command: "x" } }]);
		for (let index = 0; index < 4; index++) expect(g.recordTurn(t())).toBeNull();
	});

	it("clamps a threshold below one rather than detecting nothing at all", () => {
		// A threshold of 0 would make the comparison `count < threshold` false on
		// the very first turn, which is a detection with nothing detected. Clamped to
		// 1, the first turn is a run of one and the second is the repetition.
		const clamped = guard(0);
		const t = () => turn([{ name: "bash" }]);
		clamped.recordTurn(t());
		expect(clamped.count).toBe(1);
		expect(clamped.recordTurn(t())).not.toBeNull();

		// And it behaves identically to an explicit threshold of 1, which is the
		// point of clamping rather than rejecting the value.
		const explicit = guard(1);
		const u = () => turn([{ name: "grep" }]);
		explicit.recordTurn(u());
		expect(explicit.recordTurn(u())).not.toBeNull();
	});

	it("includes the result and argument summaries so the correction can act", () => {
		const g = guard(2);
		const t = () => turn([{ name: "bash", args: { command: "npm test" } }], ["exit code 1: 3 tests failed"]);
		g.recordTurn(t());
		const detection = g.recordTurn(t());
		expect(detection!.resultSummary).toContain("3 tests failed");
		expect(detection!.argumentsSummary).toContain("npm test");
	});
});

describe("what does not count as a loop", () => {
	it("ignores a turn with no tool calls", () => {
		// The model stopped calling tools, so the next call starts fresh.
		const g = guard(2);
		const calling = () => turn([{ name: "bash", args: { command: "x" } }]);
		g.recordTurn(calling());
		const { message, toolResults } = turn([]);
		expect(g.recordTurn({ message, toolResults })).toBeNull();
		expect(g.recordTurn(calling())).toBeNull();
		expect(g.recordTurn(calling())).not.toBeNull();
	});

	it("ignores a model that varies the arguments", () => {
		// Trying a different argument is the model trying something, and
		// suppressing exploration is worse than the cost of a few calls.
		const g = guard(2);
		for (let index = 0; index < 6; index++) {
			expect(g.recordTurn(turn([{ name: "bash", args: { command: `try ${index}` } }]))).toBeNull();
		}
	});

	it("ignores a model that alternates between two failing calls", () => {
		// The same reason: alternating is the retry-by-variation pattern, and the
		// guard deliberately does not catch it.
		const g = guard(2);
		for (let index = 0; index < 6; index++) {
			const call = index % 2 === 0 ? "read" : "grep";
			expect(g.recordTurn(turn([{ name: call, args: { q: "x" } }]))).toBeNull();
		}
	});

	it("ignores argument key order", () => {
		// Two calls differing only in key order are the same call.
		const g = guard(2);
		expect(g.recordTurn(turn([{ name: "edit", args: { path: "a.ts", old: "x", new: "y" } }]))).toBeNull();
		expect(g.recordTurn(turn([{ name: "edit", args: { new: "y", old: "x", path: "a.ts" } }]))).not.toBeNull();
	});

	it("ignores call order within a turn", () => {
		const g = guard(2);
		expect(g.recordTurn(turn([{ name: "read", args: { p: 1 } }, { name: "grep", args: { q: 2 } }]))).toBeNull();
		expect(g.recordTurn(turn([{ name: "grep", args: { q: 2 } }, { name: "read", args: { p: 1 } }]))).not.toBeNull();
	});
});

describe("the intent field is excluded from the comparison", () => {
	it("still detects a loop when only the intent changes", () => {
		// Intent is a hint about *why*, and it changes on every attempt even when
		// the call is identical. Including it would make a genuine loop invisible.
		const g = guard(2);
		expect(g.recordTurn(turn([{ name: "bash", args: { command: "x", intent: "first attempt" } }]))).toBeNull();
		expect(g.recordTurn(turn([{ name: "bash", args: { command: "x", intent: "second attempt" } }]))).not.toBeNull();
	});

	it("also excludes the pre-rename spelling, so an older session still matches itself", () => {
		const g = guard(2);
		g.recordTurn(turn([{ name: "bash", args: { command: "x", __intent: "a" } }]));
		expect(g.recordTurn(turn([{ name: "bash", args: { command: "x", __intent: "b" } }]))).not.toBeNull();
	});
});

describe("exempt tools", () => {
	it("does not count a turn made entirely of exempt calls", () => {
		// A poll is expected to be called repeatedly; counting it would let it mask
		// a real loop made of the calls around it.
		const g = guard(2, ["wait"]);
		for (let index = 0; index < 6; index++) {
			expect(g.recordTurn(turn([{ name: "wait", args: { ms: 1000 } }]))).toBeNull();
		}
	});

	it("counts a turn that mixes an exempt call with a real one", () => {
		const g = guard(2, ["wait"]);
		const t = () => turn([{ name: "wait", args: { ms: 1 } }, { name: "bash", args: { command: "x" } }]);
		expect(g.recordTurn(t())).toBeNull();
		expect(g.recordTurn(t())).not.toBeNull();
	});

	it("reports a non-exempt call when a mixed turn trips", () => {
		// The correction has to name something actionable.
		const g = guard(2, ["wait"]);
		const t = () => turn([{ name: "wait", args: { ms: 1 } }, { name: "bash", args: { command: "x" } }]);
		g.recordTurn(t());
		expect(g.recordTurn(t())!.toolName).toBe("bash");
	});

	it("resets when an exempt-only turn intervenes", () => {
		const g = guard(2, ["wait"]);
		const real = () => turn([{ name: "bash", args: { command: "x" } }]);
		g.recordTurn(real());
		g.recordTurn(turn([{ name: "wait", args: { ms: 1 } }]));
		// A fresh run, not the second turn of the old one.
		expect(g.recordTurn(real())).toBeNull();
	});
});

describe("reset", () => {
	it("clears the run at a context boundary", () => {
		const g = guard(2);
		const t = () => turn([{ name: "bash", args: { command: "x" } }]);
		g.recordTurn(t());
		g.reset();
		expect(g.count).toBe(0);
		expect(g.recordTurn(t())).toBeNull();
	});
});
