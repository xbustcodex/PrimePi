import { describe, expect, it } from "vitest";
import { countLedgerRevision, describeProgression, wiredProgression } from "../../../scripts/ledger-progression.ts";
import { buildLedger, reconcileLedger } from "../../tui/src/overlays/settings-parity-ledger.ts";

/**
 * The ledger's own history, as a checkable claim.
 *
 * A progress report once said "27 → 103 wired" while the reconciled boundary
 * before it read 66. Rather than guess which narrative number was intended, the
 * progression is derived from git and asserted here. If a report's number and
 * this one disagree, the report is wrong.
 */

describe("the wired progression is derived, not remembered", () => {
	it("starts at the first recorded count and ends at the current one", () => {
		const steps = wiredProgression();
		expect(steps.length).toBeGreaterThan(5);
		const current = reconcileLedger().byState.wired;
		expect(steps.at(-1)!.wired).toBe(current);
	});

	it("only ever increases, because a row is not un-promoted by a later commit", () => {
		// A decrease would mean a capability was withdrawn, which is a deliberate
		// act and would need saying so rather than arriving silently.
		const steps = wiredProgression();
		for (let index = 1; index < steps.length; index++) {
			expect(steps[index]!.wired, `after ${steps[index]!.hash}`).toBeGreaterThanOrEqual(steps[index - 1]!.wired);
		}
	});

	it("describes the progression without guessing", () => {
		expect(describeProgression()).toMatch(/^\d+ → \d+ wired across \d+ ledger changes; \d+ live verified at HEAD$/);
	});
});

describe("a historical count is reproducible", () => {
	it("returns undefined for a revision with no ledger", () => {
		// A revision before the ledger existed has nothing to count, and reporting
		// zero for it would put a false step at the start of the progression.
		expect(countLedgerRevision("HEAD~200")).toBeUndefined();
	});

	it("agrees with the live ledger at HEAD", () => {
		const summary = reconcileLedger();
		expect(countLedgerRevision("HEAD")!.wired).toBe(summary.byState.wired);
	});
});

describe("the live-verified count never exceeds what is wired", () => {
	it("holds at HEAD", () => {
		const entries = buildLedger();
		const wired = entries.filter((entry) => entry.state === "wired").length;
		const live = entries.filter((entry) => entry.liveVerified).length;
		expect(live).toBeLessThanOrEqual(wired);
	});
});
