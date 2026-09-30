import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildRecovery,
	classifyRecovery,
	describeRecovery,
	isEmptyErrorTurn,
	type RecoveryOutcome,
	sessionMessagePersistenceKey,
} from "../src/harness/session/turn-recovery.ts";

/**
 * Turn recovery classification.
 *
 * The rule under test is which of several things that happened gets to explain
 * the recovery in the note a user reads. Getting the order wrong produces a
 * note that is technically true and practically useless.
 */

function message(content: unknown[], stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as unknown as AssistantMessage;
}

const outcome = (overrides: Partial<RecoveryOutcome> = {}): RecoveryOutcome => ({
	switchedCredential: false,
	switchedModel: false,
	delayMs: 0,
	usageLimit: false,
	rateLimited: false,
	...overrides,
});

describe("an empty error turn is one that produced nothing", () => {
	it("is empty with no content at all", () => {
		expect(isEmptyErrorTurn(message([]))).toBe(true);
	});

	it("is empty when every block is whitespace", () => {
		expect(isEmptyErrorTurn(message([{ type: "text", text: "   \n " }]))).toBe(true);
	});

	it("is not empty when it produced text", () => {
		expect(isEmptyErrorTurn(message([{ type: "text", text: "partial" }]))).toBe(false);
	});

	it("is not empty when it produced thinking", () => {
		expect(isEmptyErrorTurn(message([{ type: "thinking", thinking: "considering" }]))).toBe(false);
	});

	it("is not empty when a tool call was made", () => {
		// A tool call is an action, not commentary: the model did something, so the
		// user may be looking at a side effect even though the turn failed.
		expect(isEmptyErrorTurn(message([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]))).toBe(false);
	});

	it("treats a redacted thinking block with a signature as content", () => {
		// The opaque payload is what the provider needs for multi-turn continuity.
		// Eliding the turn would break the next request.
		expect(
			isEmptyErrorTurn(message([{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }])),
		).toBe(false);
	});

	it("treats a redacted thinking block with nothing at all as empty", () => {
		expect(isEmptyErrorTurn(message([{ type: "thinking", thinking: "", redacted: true }]))).toBe(true);
	});

	it("treats an unknown block kind as content", () => {
		// A transcript written by a newer build must never be silently discarded by
		// an older one: the user cannot tell an elided turn from one that never
		// happened.
		expect(isEmptyErrorTurn(message([{ type: "someFutureBlock", payload: 1 } as never]))).toBe(false);
	});

	it("is never empty for a non-error stop", () => {
		expect(isEmptyErrorTurn(message([], "stop"))).toBe(false);
		expect(isEmptyErrorTurn(message([], "length"))).toBe(false);
	});
});

describe("classification order is the rule", () => {
	it("prefers a switched credential over everything else", () => {
		// Switching accounts is the most surprising thing that can have happened and
		// the most useful for a user to know.
		expect(
			classifyRecovery(outcome({ switchedCredential: true, switchedModel: true, delayMs: 5000, usageLimit: true })),
		).toBe("credential");
	});

	it("prefers a switched model over a wait", () => {
		expect(classifyRecovery(outcome({ switchedModel: true, delayMs: 5000, usageLimit: true }))).toBe("model");
	});

	it("reports a wait only for a usage limit that actually waited", () => {
		expect(classifyRecovery(outcome({ delayMs: 5000, usageLimit: true }))).toBe("wait");
		// A rate limit is reported as rate-limited in the note; calling it "waited"
		// as well would say the same thing twice.
		expect(classifyRecovery(outcome({ delayMs: 5000, usageLimit: false }))).toBe("plain");
		// And a usage limit with no delay did not wait.
		expect(classifyRecovery(outcome({ delayMs: 0, usageLimit: true }))).toBe("plain");
	});

	it("falls back to plain", () => {
		expect(classifyRecovery(outcome())).toBe("plain");
	});
});

describe("the note names what explains the recovery", () => {
	it("names the account switch", () => {
		expect(describeRecovery("credential", false)).toBe("switched account; retried");
	});

	it("names the model switch", () => {
		expect(describeRecovery("model", false)).toBe("switched model; retried");
	});

	it("names the wait", () => {
		expect(describeRecovery("wait", false)).toBe("waited; retried");
	});

	it("says rate-limited rather than error", () => {
		// A rate-limited turn is not also an error; both words add nothing there.
		expect(describeRecovery("plain", true)).toBe("rate-limited; retried");
	});

	it("combines a rate limit with the recovery that resolved it", () => {
		expect(describeRecovery("credential", true)).toBe("rate-limited; switched account; retried");
	});
});

describe("the persisted record", () => {
	it("carries the classification, the attempt and the note", () => {
		const recovery = buildRecovery(2, outcome({ switchedCredential: true }));
		expect(recovery).toEqual({
			kind: "auto-retry",
			status: "recovered",
			attempt: 2,
			recovery: "credential",
			note: "switched account; retried",
		});
	});
});

describe("persistence keys", () => {
	it("prefers a response id, which is unique", () => {
		expect(sessionMessagePersistenceKey({ responseId: "r1", timestamp: 5 })).toBe("response:r1");
	});

	it("falls back to a timestamp", () => {
		expect(sessionMessagePersistenceKey({ timestamp: 5 })).toBe("ts:5");
	});

	it("refuses to key a message it cannot address", () => {
		// Matching on content alone would supersede the wrong turn whenever two
		// turns are identical, which happens whenever a retry reproduces a turn.
		expect(sessionMessagePersistenceKey({})).toBeUndefined();
		expect(sessionMessagePersistenceKey({ responseId: "" })).toBeUndefined();
		expect(sessionMessagePersistenceKey({ timestamp: Number.NaN })).toBeUndefined();
	});
});
