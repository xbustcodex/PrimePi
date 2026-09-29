import { describe, expect, it } from "vitest";
import {
	ADVISOR_MAX_BUDGET_PER_UPDATE,
	AdvisorEmissionGuard,
	advisorSeverityRank,
	normalizeAdvisorNote,
} from "../src/advisor/emission-guard.ts";

/**
 * The advisor emission guard.
 *
 * Three properties carry this, and each corresponds to a way a watcher model can
 * waste a session.
 *
 * **Silence is suppressed, findings are not.** A watcher asked to report will
 * emit "no issues" and "looks good", and every one costs a turn of primary
 * context to say nothing. The suppression list is matched against the *whole*
 * normalized note — a substring match would drop a real blocker that happens to
 * contain the word "stop", which is the failure the list exists to avoid.
 *
 * **A blocker is never budgeted.** Dropping one to respect a per-update budget
 * would let a model that has run out of nits also run out of the ability to
 * report an actual problem.
 *
 * **A refusal names its real reason.** `rate-limit` and `duplicate` are
 * different problems with different fixes, and a rejected note described as
 * recorded teaches the model that suppression does not happen.
 */

const NIT = advisorSeverityRank("nit");
const CONCERN = advisorSeverityRank("concern");
const BLOCKER = advisorSeverityRank("blocker");

const admit = (guard: AdvisorEmissionGuard, note: string, rank: number, pending = false) =>
	guard.admit(note, { rank, pending });

describe("normalization folds the variants a model actually emits", () => {
	it("collapses punctuation and case to one key", () => {
		// "Stop.", "*Stop*" and "  stop  " are one note, not three.
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("  stop  ")).toBe("stop");
	});

	it("folds compatibility characters before the punctuation pass", () => {
		expect(normalizeAdvisorNote("ＳＴＯＰ")).toBe("stop");
	});

	it("keeps the words of a real note", () => {
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
	});
});

describe("silence is suppressed", () => {
	it("drops a bare no-concerns note", () => {
		const guard = new AdvisorEmissionGuard();
		expect(admit(guard, "No issues.", NIT)).toMatchObject({ accepted: false, reason: "noise" });
	});

	it("drops an endorsement", () => {
		const guard = new AdvisorEmissionGuard();
		expect(admit(guard, "Looks good!", NIT)).toMatchObject({ accepted: false, reason: "noise" });
	});

	it("drops a bare stop with no reason", () => {
		const guard = new AdvisorEmissionGuard();
		expect(admit(guard, "Stop.", NIT)).toMatchObject({ accepted: false, reason: "noise" });
	});

	it("keeps a blocker that merely contains a suppressed word", () => {
		// The failure this rule exists to avoid. A substring match would suppress it.
		const guard = new AdvisorEmissionGuard();
		const note = "Stop: 'await' missing on writeStream.end() will lose buffered writes.";
		expect(admit(guard, note, BLOCKER)).toMatchObject({ accepted: true });
	});

	it("rejects an empty note as empty, not as noise", () => {
		// Different reasons, different fixes: there is no text to act on at all.
		const guard = new AdvisorEmissionGuard();
		expect(admit(guard, "   ", NIT)).toMatchObject({ accepted: false, reason: "empty" });
	});
});

describe("a repeat is a duplicate, not a rate limit", () => {
	it("rejects an identical repeat", () => {
		const guard = new AdvisorEmissionGuard();
		expect(admit(guard, "The await is missing.", CONCERN)).toMatchObject({ accepted: true });
		expect(admit(guard, "The await is missing.", CONCERN)).toMatchObject({
			accepted: false,
			reason: "duplicate",
		});
	});

	it("sees through cosmetic rewording", () => {
		// The model rephrasing itself is the same finding, not a new one.
		const guard = new AdvisorEmissionGuard();
		admit(guard, "The await is missing.", CONCERN);
		expect(admit(guard, "**The await is missing!**", CONCERN)).toMatchObject({ reason: "duplicate" });
	});

	it("admits a strictly-higher severity as a real escalation", () => {
		const guard = new AdvisorEmissionGuard();
		admit(guard, "The await is missing.", NIT);
		expect(admit(guard, "The await is missing.", CONCERN)).toMatchObject({ accepted: true });
	});

	it("rejects a downgrade", () => {
		const guard = new AdvisorEmissionGuard();
		admit(guard, "The await is missing.", CONCERN);
		expect(admit(guard, "The await is missing.", NIT)).toMatchObject({ reason: "duplicate" });
	});
});

describe("a blocker is never budgeted", () => {
	it("admits blockers past the budget", () => {
		// A model out of nits must still be able to report an actual problem.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		admit(guard, "First nit.", NIT);
		for (let index = 0; index < 5; index++) {
			expect(admit(guard, `Blocker number ${index}.`, BLOCKER).accepted).toBe(true);
		}
	});

	it("still rate-limits ordinary notes once the budget is spent", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		admit(guard, "Nit one.", NIT);
		admit(guard, "Nit two.", NIT);
		expect(admit(guard, "Nit three.", NIT)).toMatchObject({ accepted: false, reason: "rate-limit" });
	});
});

describe("a configured budget may only lower the ceiling", () => {
	it("clamps above the maximum", () => {
		// Raising it would run the advisor in a mode nobody tested.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 10_000 });
		expect(guard.budget).toBe(ADVISOR_MAX_BUDGET_PER_UPDATE);
	});

	it("accepts a lower budget", () => {
		expect(new AdvisorEmissionGuard({ budgetPerUpdate: 1 }).budget).toBe(1);
	});

	it("treats a negative budget as zero rather than unlimited", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: -5 });
		expect(guard.budget).toBe(0);
		expect(admit(guard, "Anything.", NIT)).toMatchObject({ accepted: false, reason: "rate-limit" });
	});
});

describe("displacement", () => {
	it("a higher-ranked note displaces a queued lower one", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		admit(guard, "Queued nit.", NIT, true);
		admit(guard, "Routed nit.", NIT, false);
		const result = admit(guard, "Arriving concern.", CONCERN, true);
		expect(result).toMatchObject({ accepted: true });
		// The caller must drop the displaced note from its pending backlog.
		expect(result.displacedKey).toBe(normalizeAdvisorNote("Queued nit."));
	});

	it("never displaces a routed note", () => {
		// A delivery cannot be retracted, so its slot stays charged.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		admit(guard, "Already delivered.", NIT, false);
		const result = admit(guard, "Arriving concern.", CONCERN);
		expect(result).toMatchObject({ accepted: false, reason: "rate-limit" });
		expect(result.displacedKey).toBeUndefined();
	});

	it("does not displace on an equal rank", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		admit(guard, "Queued nit.", NIT, true);
		expect(admit(guard, "Another nit.", NIT)).toMatchObject({ accepted: false, reason: "rate-limit" });
	});

	it("escalates a note in place rather than charging a second slot", () => {
		// A second slot would let one problem count twice and displace a different note.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 2 });
		admit(guard, "Queued nit.", NIT, true);
		expect(guard.slotCount).toBe(1);
		admit(guard, "Queued nit.", CONCERN);
		expect(guard.slotCount).toBe(1);
	});
});

describe("routing a pending note keeps its slot", () => {
	it("marks it delivered without freeing the budget", () => {
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		admit(guard, "Queued nit.", NIT, true);
		guard.markRouted("Queued nit.");
		// The slot is charged because the note already reached the primary.
		expect(admit(guard, "Another nit.", NIT)).toMatchObject({ accepted: false, reason: "rate-limit" });
	});

	it("a pending escalation moves the dedupe rank", () => {
		// Otherwise an equal-rank repeat would be admitted as new.
		const guard = new AdvisorEmissionGuard();
		admit(guard, "Queued nit.", NIT, true);
		guard.escalatePending("Queued nit.", CONCERN);
		expect(admit(guard, "Queued nit.", CONCERN)).toMatchObject({ accepted: false, reason: "duplicate" });
	});
});

describe("reset", () => {
	it("clears the budget and the history", () => {
		// A re-primed advisor can legitimately re-raise old issues.
		const guard = new AdvisorEmissionGuard({ budgetPerUpdate: 1 });
		admit(guard, "First note.", CONCERN);
		expect(admit(guard, "First note.", CONCERN).accepted).toBe(false);
		guard.reset();
		expect(guard.slotCount).toBe(0);
		expect(admit(guard, "First note.", CONCERN).accepted).toBe(true);
	});
});

describe("the history is bounded", () => {
	it("evicts the oldest rather than growing without limit", () => {
		// A forgotten note can be re-admitted, which costs a turn; an unbounded set is
		// a leak.
		const guard = new AdvisorEmissionGuard({ historyCapacity: 2 });
		admit(guard, "Note one.", CONCERN);
		admit(guard, "Note two.", CONCERN);
		admit(guard, "Note three.", CONCERN);
		expect(admit(guard, "Note one.", CONCERN).accepted).toBe(true);
	});
});

describe("severity ranking", () => {
	it("orders nit below concern below blocker", () => {
		expect(NIT).toBeLessThan(CONCERN);
		expect(CONCERN).toBeLessThan(BLOCKER);
	});

	it("treats an unknown severity as the weakest", () => {
		expect(advisorSeverityRank("catastrophe")).toBe(NIT);
		expect(advisorSeverityRank(undefined)).toBe(NIT);
	});
});
