/**
 * Queue drain policy: how many queued messages reach the model at once.
 *
 * ## Two queues, two moments, one rule
 *
 * **Steering** messages arrive while the agent is working — the user is
 * redirecting something already in flight. **Follow-up** messages arrive after a
 * turn completes — the user is queueing the next thing.
 *
 * Both drain under the same choice, and the choice is the same shape: `all`
 * hands the model everything at once, `one-at-a-time` hands it one message and
 * waits for the model to respond before offering the next.
 *
 * ## Why one-at-a-time is the default
 *
 * A batch of queued messages reads to a model as a single instruction, and the
 * model has to reconcile them. Three messages that contradict each other produce
 * a response that satisfies none of them. Delivering one at a time lets the
 * model *act* on the first before seeing the second, which is what a user
 * queueing three things in a row actually wants.
 *
 * The cost is latency: three messages is three round trips rather than one. That
 * is the right trade by default and a user who disagrees has `all`.
 *
 * ## The queue is not the place messages go to be forgotten
 *
 * A message that has not been delivered is still pending, and still visible. A
 * drain that stops early — because the turn ended, or the user interrupted —
 * leaves the remainder in the queue rather than dropping it. Losing a message
 * the user typed is the worst outcome available, and it is the one an
 * implementation is most tempted by, because "the turn ended" feels like a
 * natural place to clear.
 *
 * ## Claiming
 *
 * At most one delivery is in flight per queue. A second dequeue while the first
 * is still being prepared would deliver the same message twice or interleave two
 * batches, and the model would see a turn that does not correspond to anything
 * the user sent.
 */

/** How a queue drains. */
export type QueueMode = "all" | "one-at-a-time";

/** Which queue a batch came from. */
export type QueueKind = "steering" | "followUp";

/** A message waiting to reach the model. */
export interface QueuedMessage {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly content: string;
}

/** The slice of a queue a drain may take. */
export interface DrainBatch {
	readonly messages: readonly QueuedMessage[];
	/** How many remain queued after this batch. */
	readonly remaining: number;
	/** Whether more will be delivered without another user action. */
	readonly willContinue: boolean;
}

/**
 * How many messages a drain may take.
 *
 * `all` takes everything queued; `one-at-a-time` takes exactly one. The mode is
 * read at drain time rather than captured, so a settings change takes effect
 * without restarting the session.
 */
export function drainSize(mode: QueueMode, queued: number): number {
	if (queued <= 0) return 0;
	// An unrecognised mode drains one at a time. That is the conservative choice:
	// it costs a round trip, where `all` could deliver contradictory instructions
	// as a single turn.
	return mode === "all" ? queued : 1;
}

/** Takes the next batch from a queue, leaving the rest queued. */
export function takeBatch(queue: readonly QueuedMessage[], mode: QueueMode, kind: QueueKind): DrainBatch {
	const size = drainSize(mode, queue.length);
	const messages = queue.slice(0, size);
	const remaining = queue.length - size;
	return {
		messages,
		remaining,
		// A follow-up queue is a run of work the user lined up, so it keeps draining
		// on its own under either mode. A steering queue is the user redirecting
		// something in flight, so `one-at-a-time` stops after each message: the
		// caller waits for the response before offering the next, which is the whole
		// point of choosing it.
		willContinue: remaining > 0 && (kind === "followUp" || mode === "all"),
	};
}

/**
 * Tracks at most one in-flight delivery per queue.
 *
 * Without this, a dequeue while a delivery is still being prepared delivers the
 * same message twice, and the model sees a turn the user never sent.
 */
export class QueueClaim {
	readonly #claims = new Set<QueueKind>();

	get isClaimed(): boolean {
		return this.#claims.size > 0;
	}

	/** Claims a queue, or reports that it is already claimed. */
	claim(kind: QueueKind): boolean {
		if (this.#claims.has(kind)) return false;
		this.#claims.add(kind);
		return true;
	}

	release(kind: QueueKind): void {
		this.#claims.delete(kind);
	}

	has(kind: QueueKind): boolean {
		return this.#claims.has(kind);
	}
}

/**
 * The messages still owed to the user, for a status line.
 *
 * Surfacing this is what makes a partially-drained queue honest. A user who
 * queued three things and sees only one answered has no other way to know the
 * other two are still pending rather than lost.
 */
export interface QueueState {
	readonly steering: number;
	readonly followUp: number;
}

export function describeQueueState(state: QueueState): string {
	const parts: string[] = [];
	if (state.steering > 0) parts.push(`${state.steering} steering`);
	if (state.followUp > 0) parts.push(`${state.followUp} follow-up`);
	return parts.length === 0 ? "no queued messages" : `queued: ${parts.join(", ")}`;
}
