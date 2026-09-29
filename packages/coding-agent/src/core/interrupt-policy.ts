/**
 * Interrupt policy: when a queued message stops work already in flight.
 *
 * ## What the user is choosing between
 *
 * A user who types while the agent is working wants *something* to happen, and
 * there are two defensible readings:
 *
 * - **immediate** — stop now. The user's message is about what they want next,
 *   and finishing the current step first wastes their time and may spend
 *   money on work they have already redirected.
 * - **wait** — let the current step finish. Some steps are not safe to abandon
 *   halfway: a file half-written, a deploy half-applied, a transaction open.
 *
 * ## The rule that makes `wait` safe
 *
 * **`wait` only spares side-effecting work.** A tool marked *interruptible* —
 * a pure read, a poll, a wait — is always cut short, even under `wait`.
 *
 * The reason is that a pure wait has nothing to finish. Leaving it running with
 * a message already queued means the user is stuck for the full window waiting
 * for a result nobody will use. A side-effecting step, by contrast, may be
 * mid-write, and cutting it is how a file gets corrupted.
 *
 * So `wait` is not "ignore the user". It is "do not abandon work that would
 * leave something broken", and it is scoped as narrowly as it can be.
 *
 * ## Failure of a resolver is not a licence to interrupt
 *
 * When a tool decides interruptibility from its arguments, a resolver that
 * throws resolves to *not* interruptible. The default preserves the tool's
 * outcome: a bug in a policy function must not become a way to abort a
 * half-finished write.
 */

/** How a queued message affects work in flight. */
export type InterruptMode = "immediate" | "wait";

/** Whether a tool may be abandoned mid-call. */
export type Interruptibility = boolean | ((args: Record<string, unknown>) => boolean);

/** What the policy decided, and why. */
export interface InterruptDecision {
	/** Whether the in-flight call may be abandoned. */
	readonly interrupt: boolean;
	readonly reason: string;
}

/** One tool call awaiting a decision. */
export interface InFlightCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	/** How the tool declares interruptibility. Absent means not interruptible. */
	readonly interruptible?: Interruptibility;
}

/** Resolves a tool's interruptibility, treating a resolver failure as false. */
export function isInterruptible(call: InFlightCall): boolean {
	const declared = call.interruptible;
	if (typeof declared === "function") {
		try {
			// Resolved from the call's own arguments, so an argument-dependent policy
			// governs the call that actually runs.
			return declared(call.args);
		} catch {
			// A bug in a policy function must not become a way to abort a
			// half-finished side effect.
			return false;
		}
	}
	return declared === true;
}

/** Whether any in-flight call may be abandoned, under a mode. */
export function shouldInterrupt(mode: InterruptMode, calls: readonly InFlightCall[]): InterruptDecision {
	// Immediate: the user is redirecting, so stop as soon as something is
	// stoppable.
	const interruptible = calls.filter(isInterruptible);
	if (mode === "immediate") {
		return interruptible.length > 0
			? { interrupt: true, reason: `immediate mode: ${interruptible[0]!.name} is interruptible` }
			: { interrupt: false, reason: "immediate mode, but no in-flight call is interruptible" };
	}
	// Wait: spare side-effecting work entirely.
	const sideEffecting = calls.filter((call) => !isInterruptible(call));
	if (sideEffecting.length === 0) {
		return {
			interrupt: true,
			// Not because the mode is being ignored: because a pure wait has nothing
			// to finish, and leaving it running strands the user for its full window.
			reason: "wait mode, but every in-flight call is interruptible",
		};
	}
	return {
		interrupt: false,
		reason: `wait mode: ${sideEffecting[0]!.name} may have side effects in progress`,
	};
}

/**
 * What the user asked for, and whether it should take effect now.
 *
 * A user who interrupts during a non-interruptible call is not ignored: the
 * message is queued and applied when the call settles, which is what makes
 * `wait` a delay rather than a discard.
 */
/** A message the user sent while work was in flight. */
export interface QueuedUserMessage {
	readonly id: string;
	readonly content: string;
}

export interface PendingInterruption {
	readonly message: QueuedUserMessage;
	/** Why it was deferred rather than dropped. */
	readonly deferredBecause: string;
}

/** Decides whether a queued message applies now or waits for the current call. */
export function resolveInterruption(
	mode: InterruptMode,
	queued: readonly QueuedUserMessage[],
	calls: readonly InFlightCall[],
): { apply: boolean; pending: readonly PendingInterruption[] } {
	const decision = shouldInterrupt(mode, calls);
	if (decision.interrupt) return { apply: true, pending: [] };
	// Nothing may be interrupted, so the message waits rather than being lost. A
	// user who typed during a long write still gets their message honoured.
	return {
		apply: false,
		pending: queued.map((message) => ({ message, deferredBecause: decision.reason })),
	};
}
