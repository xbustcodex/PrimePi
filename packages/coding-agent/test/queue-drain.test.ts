import { describe, expect, it } from "vitest";
import {
	describeQueueState,
	drainSize,
	QueueClaim,
	takeBatch,
	type QueuedMessage,
} from "../src/core/queue-drain.ts";

/**
 * Queue drain policy.
 *
 * The property that matters most: an undelivered message is still owed to the
 * user. A drain that stops early leaves the remainder queued, because losing
 * something the user typed is the worst outcome available.
 */

const messages = (count: number): QueuedMessage[] =>
	Array.from({ length: count }, (_, index) => ({ id: `m${index}`, role: "user" as const, content: `message ${index}` }));

describe("how much a drain takes", () => {
	it("takes one at a time under the default", () => {
		// Three messages that contradict each other produce a response satisfying
		// none of them; one at a time lets the model act on the first before
		// seeing the second.
		expect(drainSize("one-at-a-time", 3)).toBe(1);
	});

	it("takes everything under all", () => {
		expect(drainSize("all", 3)).toBe(3);
	});

	it("takes nothing from an empty queue", () => {
		expect(drainSize("all", 0)).toBe(0);
		expect(drainSize("one-at-a-time", 0)).toBe(0);
	});

	it("drains one at a time for an unrecognised mode", () => {
		// The conservative choice: it costs a round trip, where `all` could deliver
		// contradictory instructions as a single turn.
		expect(drainSize("garbage" as never, 3)).toBe(1);
	});
});

describe("taking a batch leaves the rest queued", () => {
	it("takes one and reports what remains", () => {
		const batch = takeBatch(messages(3), "one-at-a-time", "steering");
		expect(batch.messages).toHaveLength(1);
		expect(batch.remaining).toBe(2);
	});

	it("takes all and reports nothing remaining", () => {
		const batch = takeBatch(messages(3), "all", "followUp");
		expect(batch.messages).toHaveLength(3);
		expect(batch.remaining).toBe(0);
	});

	it("never loses a message across a sequence of drains", () => {
		// The property: queue three, drain one at a time, and every message appears
		// exactly once across the batches.
		const queue = messages(3);
		const delivered: string[] = [];
		let remaining = queue;
		let guard = 0;
		while (remaining.length > 0 && guard++ < 10) {
			const batch = takeBatch(remaining, "one-at-a-time", "steering");
			delivered.push(...batch.messages.map((message) => message.id));
			remaining = remaining.slice(batch.messages.length);
		}
		expect(delivered).toEqual(["m0", "m1", "m2"]);
		expect(new Set(delivered).size).toBe(3);
	});

	it("reports whether the drain will continue on its own", () => {
		// A follow-up queue is a run of work the user lined up, so it keeps draining
		// under either mode while anything is left.
		expect(takeBatch(messages(2), "one-at-a-time", "followUp").willContinue).toBe(true);
		// Nothing left, nothing to continue to - under `all` a single message drains
		// the whole queue.
		expect(takeBatch(messages(1), "all", "followUp").willContinue).toBe(false);
		// Steering under `all` drains the whole queue, so there is never anything left
		// to continue to - the batch *is* the rest of the work.
		expect(takeBatch(messages(3), "all", "steering").willContinue).toBe(false);
		// With one-at-a-time the caller waits for the response before offering the
		// next, whatever the queue holds.
		expect(takeBatch(messages(2), "one-at-a-time", "steering").willContinue).toBe(false);
	});
});

describe("at most one delivery per queue", () => {
	it("refuses a second claim while one is in flight", () => {
		// Two concurrent deliveries would send the same message twice, and the model
		// would see a turn the user never sent.
		const claims = new QueueClaim();
		expect(claims.claim("steering")).toBe(true);
		expect(claims.claim("steering")).toBe(false);
		expect(claims.has("steering")).toBe(true);
	});

	it("allows the other queue to be claimed independently", () => {
		const claims = new QueueClaim();
		expect(claims.claim("steering")).toBe(true);
		expect(claims.claim("followUp")).toBe(true);
		expect(claims.isClaimed).toBe(true);
	});

	it("allows a re-claim after release", () => {
		const claims = new QueueClaim();
		claims.claim("steering");
		claims.release("steering");
		expect(claims.isClaimed).toBe(false);
		expect(claims.claim("steering")).toBe(true);
	});
});

describe("queue state is visible", () => {
	it("reports nothing queued when both are empty", () => {
		expect(describeQueueState({ steering: 0, followUp: 0 })).toBe("no queued messages");
	});

	it("reports each non-empty queue", () => {
		// A user who queued three things and saw one answered has no other way to
		// know the other two are pending rather than lost.
		expect(describeQueueState({ steering: 2, followUp: 0 })).toBe("queued: 2 steering");
		expect(describeQueueState({ steering: 0, followUp: 1 })).toBe("queued: 1 follow-up");
		expect(describeQueueState({ steering: 1, followUp: 2 })).toBe("queued: 1 steering, 2 follow-up");
	});
});
