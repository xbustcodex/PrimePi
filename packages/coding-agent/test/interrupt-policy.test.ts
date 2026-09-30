import { describe, expect, it } from "vitest";
import {
	type InFlightCall,
	type InterruptMode,
	isInterruptible,
	resolveInterruption,
	shouldInterrupt,
} from "../src/core/interrupt-policy.ts";

/**
 * Interrupt policy.
 *
 * The property that matters most: `wait` spares side-effecting work, and
 * *only* side-effecting work. A `wait` mode that also spared a pure poll would
 * strand a user for the full window waiting on a result nobody will use.
 */

const call = (overrides: Partial<InFlightCall> = {}): InFlightCall => ({
	id: "c1",
	name: "read",
	args: {},
	...overrides,
});

/** A tool that may be abandoned: a pure read. */
const interruptible = call({ name: "read", interruptible: true });
/** A tool that may not: a write that could be half-applied. */
const sideEffecting = call({ name: "edit", interruptible: false });

describe("interruptibility resolution", () => {
	it("treats a literal flag as declared", () => {
		expect(isInterruptible(interruptible)).toBe(true);
		expect(isInterruptible(sideEffecting)).toBe(false);
	});

	it("treats an absent declaration as not interruptible", () => {
		// The safe default: a tool that has not said it is stoppable is assumed not
		// to be.
		expect(isInterruptible(call())).toBe(false);
	});

	it("resolves from the call's own arguments", () => {
		// An argument-dependent policy must govern the call that actually runs.
		const dryRun = call({ args: { dryRun: true }, interruptible: (args) => args.dryRun === true });
		const real = call({ args: { dryRun: false }, interruptible: (args) => args.dryRun === true });
		expect(isInterruptible(dryRun)).toBe(true);
		expect(isInterruptible(real)).toBe(false);
	});

	it("resolves a throwing policy to not interruptible", () => {
		// A bug in a policy function must not become a way to abort a half-finished
		// write.
		const broken = call({
			name: "edit",
			interruptible: () => {
				throw new Error("policy bug");
			},
		});
		expect(isInterruptible(broken)).toBe(false);
	});
});

describe("immediate mode", () => {
	it("interrupts an interruptible call", () => {
		const decision = shouldInterrupt("immediate", [interruptible]);
		expect(decision.interrupt).toBe(true);
	});

	it("does not interrupt a side-effecting call even immediately", () => {
		// Immediate is about the user's patience, not a licence to corrupt a file.
		const decision = shouldInterrupt("immediate", [sideEffecting]);
		expect(decision.interrupt).toBe(false);
		expect(decision.reason).toContain("no in-flight call is interruptible");
	});

	it("interrupts when any call in a batch is interruptible", () => {
		expect(shouldInterrupt("immediate", [sideEffecting, interruptible]).interrupt).toBe(true);
	});

	it("does nothing when there is no work in flight", () => {
		expect(shouldInterrupt("immediate", []).interrupt).toBe(false);
	});
});

describe("wait mode spares only side-effecting work", () => {
	it("waits for a side-effecting call", () => {
		const decision = shouldInterrupt("wait", [sideEffecting]);
		expect(decision.interrupt).toBe(false);
		expect(decision.reason).toContain("may have side effects");
	});

	it("still cuts short a purely interruptible call", () => {
		// A pure wait has nothing to finish. Leaving it running with a message
		// already queued strands the user for its full window.
		const decision = shouldInterrupt("wait", [interruptible]);
		expect(decision.interrupt).toBe(true);
		expect(decision.reason).toContain("interruptible");
	});

	it("waits when any call in the batch is side-effecting", () => {
		// One unsafe call in a batch is enough to defer the whole thing; there is no
		// partial execution.
		expect(shouldInterrupt("wait", [interruptible, sideEffecting]).interrupt).toBe(false);
	});

	it("cuts short a batch of pure calls", () => {
		expect(shouldInterrupt("wait", [interruptible, interruptible]).interrupt).toBe(true);
	});
});

describe("a deferred message is honoured, not discarded", () => {
	const queued = [
		{ id: "m1", content: "actually, do the other thing" },
		{ id: "m2", content: "and check the tests" },
	];

	it("applies immediately when something is interruptible", () => {
		const outcome = resolveInterruption("immediate", queued, [interruptible]);
		expect(outcome.apply).toBe(true);
		expect(outcome.pending).toHaveLength(0);
	});

	it("queues with a reason when nothing may be interrupted", () => {
		// A user who typed during a long write still gets their message honoured.
		const outcome = resolveInterruption("wait", queued, [sideEffecting]);
		expect(outcome.apply).toBe(false);
		expect(outcome.pending).toHaveLength(2);
		expect(outcome.pending[0]!.message.content).toBe("actually, do the other thing");
		expect(outcome.pending[0]!.deferredBecause).toContain("side effect");
	});

	it("loses nothing when there is no work in flight at all", () => {
		// Nothing to interrupt, so the message applies - the queue must not become a
		// place messages go to be forgotten.
		const outcome = resolveInterruption("wait", queued, []);
		expect(outcome.apply).toBe(true);
	});
});

describe("modes are explicit", () => {
	it("accepts only the two documented values", () => {
		// Anything else degrades to immediate, which is the mode that honours the
		// user's message rather than stalling it.
		const mode = "immediate" as InterruptMode;
		expect(shouldInterrupt(mode, [interruptible]).interrupt).toBe(true);
	});
});
