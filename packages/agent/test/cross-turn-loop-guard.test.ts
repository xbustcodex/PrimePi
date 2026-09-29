import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CrossTurnLoopGuard,
	type LoopGuardAction,
	type LoopGuardHost,
	redirectText,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
	toolCallLoopRedirectDetails,
} from "../src/loop-guards/cross-turn.ts";

/**
 * Cross-turn loop guards.
 *
 * The property that carries this module is **two strikes, and the second is an
 * abort**. A first offence gets a corrective; a model that ignores it will not be
 * reasoned with, and two redirects would invite an unbounded sequence of them.
 *
 * The subtle part is re-arming. If the guard kept its detection state after the
 * first redirect, the same bound would trip again on the very next turn and the
 * abort would fire on offence one — the escalation would be unreachable in
 * exactly the situation it exists for.
 */

const THRESHOLD = 3;

const assistantWith = (toolName: string, args: string): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: toolName, arguments: JSON.parse(args) }],
		timestamp: 1,
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	}) as unknown as AssistantMessage;

const toolResult = (): ToolResultMessage =>
	({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "grep",
		content: [{ type: "text", text: "no matches" }],
		isError: false,
		timestamp: 1,
	}) as unknown as ToolResultMessage;

function makeHost(overrides: Partial<LoopGuardHost> = {}) {
	const live: unknown[] = [];
	const aborted: Error[] = [];
	const warnings: string[] = [];
	// Mutable so a test can change the settings between turns; the guard reads them
	// live, which is the behaviour under test.
	const host = {
		settings: { enabled: true, threshold: THRESHOLD, exemptTools: [] },
		name: "session",
		liveMessages: () => live,
		appendMessage: (message) => live.push(message),
		abort: (reason) => aborted.push(reason),
		warn: (message: string) => warnings.push(message),
		...overrides,
	} as { -readonly [K in keyof LoopGuardHost]: LoopGuardHost[K] };
	return { host, live, aborted, warnings };
}

/** Feeds `times` identical turns and returns each action. */
function repeatTurns(guard: CrossTurnLoopGuard, times: number): LoopGuardAction[] {
	const actions: LoopGuardAction[] = [];
	for (let i = 0; i < times; i++) {
		actions.push(
			guard.recordTurn({ message: assistantWith("grep", '{"pattern":"foo"}'), toolResults: [toolResult()] }),
		);
	}
	return actions;
}

describe("a first offence is corrected, not aborted", () => {
	it("stays quiet below the threshold", () => {
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		expect(
			guard.recordTurn({ message: assistantWith("grep", '{"pattern":"foo"}'), toolResults: [toolResult()] }).action,
		).toBe("none");
	});

	it("redirects once the calls repeat", () => {
		const { host } = makeHost();
		const actions = repeatTurns(new CrossTurnLoopGuard(host), THRESHOLD);
		expect(actions[THRESHOLD - 1]?.action).toBe("redirect");
	});

	it("names the tool, the count, the arguments and the last result", () => {
		// A corrective the model cannot act on is just noise in its context.
		const { host } = makeHost();
		const actions = repeatTurns(new CrossTurnLoopGuard(host), THRESHOLD);
		const redirect = actions[THRESHOLD - 1];
		if (redirect?.action !== "redirect") return;
		const text = String(redirect.message);
		expect(text).toContain("grep");
		expect(text).toContain(String(THRESHOLD));
		expect(text).toContain("foo");
		expect(text).toContain("no matches");
		expect(text).toContain("NEVER call `grep`");
	});

	it("says so when a tool returned no text", () => {
		const { host } = makeHost();
		const empty = { ...toolResult(), content: [] } as unknown as ToolResultMessage;
		const guard = new CrossTurnLoopGuard(host);
		let action: LoopGuardAction = { action: "none" };
		for (let i = 0; i < THRESHOLD; i++) {
			action = guard.recordTurn({ message: assistantWith("grep", '{"pattern":"foo"}'), toolResults: [empty] });
		}
		if (action.action !== "redirect") return;
		expect(String(action.message)).toContain("(no text result)");
	});

	it("records structured details alongside the text", () => {
		const { host } = makeHost();
		const actions = repeatTurns(new CrossTurnLoopGuard(host), THRESHOLD);
		const redirect = actions[THRESHOLD - 1];
		if (redirect?.action !== "redirect") return;
		expect(redirect.details.toolName).toBe("grep");
		expect(redirect.details.count).toBeGreaterThanOrEqual(THRESHOLD);
	});
});

describe("a second offence aborts", () => {
	it("aborts when the redirect is ignored", () => {
		// A model that ignored the corrective will not be reasoned with, and two
		// redirects would invite an unbounded sequence of them.
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		repeatTurns(guard, THRESHOLD);
		const after = repeatTurns(guard, THRESHOLD);
		expect(after.some((action) => action.action === "abort")).toBe(true);
	});

	it("does not abort on the first offence", () => {
		// The escalation must be reachable; this is the case it exists for.
		const { host } = makeHost();
		const actions = repeatTurns(new CrossTurnLoopGuard(host), THRESHOLD);
		expect(actions.every((action) => action.action !== "abort")).toBe(true);
	});

	it("aborts exactly once, then starts clean", () => {
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		repeatTurns(guard, THRESHOLD);
		const second = repeatTurns(guard, THRESHOLD);
		const third = repeatTurns(guard, THRESHOLD);
		expect(second.filter((a) => a.action === "abort")).toHaveLength(1);
		// The reset after aborting means the next offence earns a fresh redirect
		// rather than aborting again immediately.
		expect(third.filter((a) => a.action === "abort")).toHaveLength(0);
		expect(third.filter((a) => a.action === "redirect")).toHaveLength(1);
	});

	it("names the tool in the abort reason", () => {
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		repeatTurns(guard, THRESHOLD);
		const after = repeatTurns(guard, THRESHOLD);
		const abort = after.find((a) => a.action === "abort");
		if (abort?.action !== "abort") return;
		expect(abort.reason.message).toContain("grep");
		expect(abort.reason.message).toContain("session");
	});
});

describe("different arguments are not a loop", () => {
	it("does not redirect when the arguments change", () => {
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		for (let i = 0; i < THRESHOLD * 3; i++) {
			guard.recordTurn({ message: assistantWith("grep", `{"pattern":"p${i}"}`), toolResults: [toolResult()] });
		}
		expect(guard.redirected).toBe(false);
	});

	it("does not redirect when the tool changes", () => {
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		for (let i = 0; i < THRESHOLD * 3; i++) {
			guard.recordTurn({ message: assistantWith(`tool${i}`, '{"a":1}'), toolResults: [toolResult()] });
		}
		expect(guard.redirected).toBe(false);
	});
});

describe("an exempt tool is not counted", () => {
	it("never redirects for an exempt tool", () => {
		// A read-only tool the model may legitimately repeat must not be bounded.
		const { host } = makeHost({ settings: { enabled: true, threshold: THRESHOLD, exemptTools: ["grep"] } });
		const guard = new CrossTurnLoopGuard(host);
		for (let i = 0; i < THRESHOLD * 4; i++) {
			guard.recordTurn({ message: assistantWith("grep", '{"pattern":"foo"}'), toolResults: [toolResult()] });
		}
		expect(guard.redirected).toBe(false);
	});

	it("still bounds a non-exempt tool alongside it", () => {
		const { host } = makeHost({ settings: { enabled: true, threshold: THRESHOLD, exemptTools: ["grep"] } });
		const guard = new CrossTurnLoopGuard(host);
		let redirect: LoopGuardAction = { action: "none" };
		for (let i = 0; i < THRESHOLD; i++) {
			redirect = guard.recordTurn({ message: assistantWith("edit", '{"path":"a"}'), toolResults: [toolResult()] });
		}
		expect(redirect.action).toBe("redirect");
	});
});

describe("disabling clears the escalation", () => {
	it("does nothing at all when disabled", () => {
		const { host } = makeHost({ settings: { enabled: false, threshold: THRESHOLD, exemptTools: [] } });
		const guard = new CrossTurnLoopGuard(host);
		expect(repeatTurns(guard, THRESHOLD * 3).every((action) => action.action === "none")).toBe(true);
	});

	it("does not resume an escalation the user turned off", () => {
		// Re-enabling must not pick up a count the user disabled the guard for.
		const settings: LoopGuardHost["settings"] = { enabled: true, threshold: THRESHOLD, exemptTools: [] };
		const { host } = makeHost({ settings });
		const guard = new CrossTurnLoopGuard(host);
		repeatTurns(guard, THRESHOLD - 1);
		host.settings = { ...settings, enabled: false };
		repeatTurns(guard, THRESHOLD * 2);
		host.settings = settings;
		expect(guard.count).toBe(0);
		expect(repeatTurns(guard, THRESHOLD - 1).every((action) => action.action === "none")).toBe(true);
	});
});

describe("a changed threshold rebuilds the detector", () => {
	it("does not carry a count across a threshold change", () => {
		// A guard built at one threshold does not hold a count valid at another.
		const settings: LoopGuardHost["settings"] = { enabled: true, threshold: 10, exemptTools: [] };
		const { host } = makeHost({ settings });
		const guard = new CrossTurnLoopGuard(host);
		repeatTurns(guard, 4);
		host.settings = { ...settings, threshold: THRESHOLD };
		expect(guard.count).toBe(0);
	});
});

describe("the shared wording", () => {
	it("exposes one custom type for the primary session", () => {
		expect(TOOL_CALL_LOOP_REDIRECT_TYPE).toBe("tool-call-loop-redirect");
	});

	it("is identical for both loops", () => {
		// A model that sees two different correctives for the same fault will treat
		// one as noise.
		const { host } = makeHost();
		const guard = new CrossTurnLoopGuard(host);
		const action = repeatTurns(guard, THRESHOLD)[THRESHOLD - 1];
		if (action?.action !== "redirect") return;
		expect(String(action.message)).toBe(
			redirectText({
				toolName: "grep",
				count: THRESHOLD,
				argumentsSummary: '{"pattern":"foo"}',
				resultSummary: "no matches",
			} as never),
		);
	});

	it("carries structured details for a renderer", () => {
		const details = toolCallLoopRedirectDetails({
			toolName: "grep",
			count: 4,
			argumentsSummary: "{}",
			resultSummary: "out",
		} as never);
		expect(details).toEqual({ toolName: "grep", count: 4, argumentsSummary: "{}", resultSummary: "out" });
	});
});
