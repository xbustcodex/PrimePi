import { describe, expect, it } from "vitest";
import { countLedgerRevision, describeProgression, promotionProgression } from "../../../scripts/ledger-progression.ts";
import { buildLedger, EVIDENCE_CLASSES, reconcileLedger } from "../../tui/src/overlays/settings-parity-ledger.ts";

/**
 * The ledger's own history, as a checkable claim.
 *
 * A progress report once said "27 → 103 wired" while the reconciled boundary
 * before it read 66. Rather than guess which narrative number was intended, the
 * progression is derived from git and asserted here. If a report's number and
 * this one disagree, the report is wrong.
 *
 * ## What it counts
 *
 * Promotions, not integrations. On 2026-09-30 a reachability audit found 223 of
 * 249 promoted rows had no consumer at all, so "wired" was measuring intent. The
 * history is still worth keeping — how many rows were *claimed* migrated is a
 * fact about the program — but it is named for what it measures, and it is not the
 * completion signal. Runtime reachability comes from the audit, which reads the
 * repository.
 */

// The progression reads 59 ledger revisions out of git on a cold cache, which is
// ~18s on this machine — slow for a test, and nothing here is worth asserting twice.
const GIT_WALK_TIMEOUT_MS = 120_000;

describe("the promotion progression is derived, not remembered", () => {
	it(
		"starts at the first recorded count and ends at the current one",
		() => {
			const steps = promotionProgression();
			expect(steps.length).toBeGreaterThan(5);
			const current = buildLedger().filter((entry) => entry.promoted !== undefined).length;
			expect(steps.at(-1)!.promoted, "the last step must match the ledger at HEAD").toBe(current);
		},
		GIT_WALK_TIMEOUT_MS,
	);

	it("only ever increases, because a row is not un-promoted by a later commit", () => {
		// A decrease would mean a claim was withdrawn, which is a deliberate act and
		// would need saying so rather than arriving silently.
		const steps = promotionProgression();
		for (let index = 1; index < steps.length; index++) {
			expect(steps[index]!.promoted, `after ${steps[index]!.hash}`).toBeGreaterThanOrEqual(
				steps[index - 1]!.promoted,
			);
		}
	});

	it(
		"describes the progression without guessing",
		() => {
			const text = describeProgression();
			expect(text).toMatch(/→ \d+ promoted across \d+ ledger changes/);
			// The sentence that keeps the number from being read as integration.
			expect(text).toContain("not runtime reachability");
		},
		GIT_WALK_TIMEOUT_MS,
	);
});

describe("a historical count is reproducible", () => {
	it("returns undefined for a revision with no ledger", () => {
		// A revision before the ledger existed has nothing to count, and reporting
		// zero for it would put a false step at the start of the progression.
		expect(countLedgerRevision("HEAD~200")).toBeUndefined();
	});

	it(
		"agrees with the live ledger at HEAD",
		() => {
			const summary = reconcileLedger();
			const current = buildLedger().filter((entry) => entry.promoted !== undefined).length;
			expect(countLedgerRevision("HEAD")!.promoted, "a historical count must match the current ledger").toBe(
				current,
			);
			expect(summary.total).toBeGreaterThan(0);
		},
		GIT_WALK_TIMEOUT_MS,
	);
});

describe("the evidence classes are ordered and never collapse", () => {
	it("holds live within behavioural within reachable", () => {
		// The corrected invariant. The old one was LIVE_VERIFIED subset WIRED, which
		// said nothing: a `wired` row could be entirely inert.
		const { byEvidence } = reconcileLedger();
		expect(byEvidence["live-verified"]).toBeLessThanOrEqual(byEvidence["behaviourally-verified"]);
		expect(byEvidence["behaviourally-verified"]).toBeLessThanOrEqual(byEvidence["runtime-reachable"]);
		expect(byEvidence["runtime-reachable"]).toBeLessThanOrEqual(byEvidence.registered);
	});

	it("every row carries exactly one class", () => {
		const entries = buildLedger();
		for (const entry of entries) expect(EVIDENCE_CLASSES).toContain(entry.evidence);
	});
});
