import { describe, expect, it } from "vitest";
import { AdvisorEmissionGuard } from "../src/advisor/emission-guard.ts";

/**
 * An escalation has to take effect on the slot, not only on the dedupe record.
 *
 * `escalatePending` is the one path that raises a note's severity *after* it has
 * already been admitted — the still-queued note is upgraded. `admit` decides
 * displacement by comparing the incoming rank against the *slot's* rank, so an
 * escalation that moved only the seen-map left the slot at its original rank and the
 * escalation did nothing to the thing it exists to control.
 */
describe("escalatePending", () => {
	it("raises the charged slot's rank so an equal-rank note cannot displace it", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		expect(guard.admit("first note", { rank: 1, pending: true })).toEqual({ accepted: true });

		// The queued note is upgraded from nit to concern.
		guard.escalatePending("first note", 2);

		// Before this was fixed the slot still carried rank 1, so this second note —
		// the same rank the first was just escalated TO — displaced it:
		//   { accepted: true, displacedKey: "first note" }
		// An escalation that another equal-rank note can undo is not an escalation.
		expect(guard.admit("second note", { rank: 2, pending: true })).toEqual({
			accepted: false,
			reason: "rate-limit",
		});
	});

	it("still lets a strictly higher rank displace an unescalated note", () => {
		// The guard must not become absolute: displacement is the point of a budget.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		guard.admit("low", { rank: 1, pending: true });
		// rank 2, not 3: a blocker is never dropped to the budget (emission-guard.ts
		// takes that branch before displacement is considered at all), so it would pass
		// for a reason that has nothing to do with the escalation fix.
		expect(guard.admit("high", { rank: 2, pending: true })).toEqual({
			accepted: true,
			displacedKey: "low",
		});
	});

	it("charges no slot for a note that was never admitted", () => {
		// `escalatePending` is documented as not charging a slot, so an escalation for
		// a note that never held one must leave the budget untouched.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		guard.escalatePending("never admitted", 2);
		expect(guard.admit("fresh", { rank: 1, pending: true })).toEqual({ accepted: true });
	});

	it("does not make a routed note displaceable", () => {
		// `markRouted` keeps the slot charged, and a routed slot is not a candidate for
		// displacement. Unchanged by this fix, and worth pinning because it is the
		// other half of the same loop.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		guard.admit("x", { rank: 1, pending: true });
		guard.markRouted("x");
		expect(guard.admit("y", { rank: 5, pending: true })).toEqual({ accepted: true });
	});
});
