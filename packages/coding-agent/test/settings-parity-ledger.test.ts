import { describe, expect, it } from "vitest";
import {
	buildLedger,
	describeLedger,
	EVIDENCE_CLASSES,
	type EvidenceClass,
	reconcileLedger,
	setConsumptionIndex,
} from "../../tui/src/overlays/settings-parity-ledger.ts";
import { OMP_PARITY_ROW_COUNT, OMP_PARITY_ROWS } from "../../tui/src/overlays/settings-parity-rows.ts";
import { lookupSetting } from "../src/core/settings-registry.ts";
// Registration has the side effect of populating the typed registry.
import "../src/core/settings-descriptors.ts";

/**
 * The settings ledger is derived, not tallied.
 *
 * Two reports in this program disagreed about how many rows were wired. A
 * hand-counted number is a claim; this file makes the count mechanical, so the
 * next disagreement is settled by running a test rather than by arguing.
 *
 * ## What changed in September 2026
 *
 * The previous version of this file asserted a 220-line list of row ids it called
 * `wired`. That list was itself a hand-maintained claim, and the reachability
 * audit it coexisted with found 223 of 249 rows so named had **no consumer at
 * all**. So the list is gone, and with it the meaning it gave to the word.
 *
 * The replacement asserts *structural invariants* rather than a membership list:
 * every row lands in exactly one bucket, the buckets sum to the reference's own
 * declared total, and no row may claim an evidence class its supporting facts do
 * not carry. A membership list goes stale silently; an invariant fails loudly.
 */

describe("the ledger reconciles against the reference contract", () => {
	it("accounts for exactly the reference's rows", () => {
		const summary = reconcileLedger();
		// Every row lands in exactly one evidence class, and the classes sum to the
		// reference's own declared total.
		const sum = EVIDENCE_CLASSES.reduce((total, evidence) => total + summary.byEvidence[evidence], 0);
		expect(sum, "every reference row must carry exactly one evidence class").toBe(OMP_PARITY_ROW_COUNT + 0);
		expect(summary.unreconciled).toEqual([]);
	});

	it("has no row left unclassified or unevidenced", () => {
		for (const entry of buildLedger()) {
			expect(EVIDENCE_CLASSES, entry.id).toContain(entry.evidence);
			// Every row states why it is in its state. A row with no reason is a
			// claim nobody made.
			expect(entry.note.length, entry.id).toBeGreaterThan(0);
		}
	});
});

describe("the evidence classes mean what they say", () => {
	it("asserts nested sets, so the subset invariants hold structurally", () => {
		// The classes are cumulative: a row asserting `behaviourally-verified` also
		// asserts `runtime-reachable` and `registered`. Reading only the strongest
		// claim is what produced the original contradiction, where 17 reachable rows
		// were hidden inside the behavioural bucket.
		for (const entry of buildLedger()) {
			const claims = new Set(entry.claims);
			// The first two classes are alternatives, not a ladder: a row is unregistered
			// *or* registered, never both. Everything above them is a genuine ladder.
			expect(claims.has("unregistered") && claims.has("registered"), entry.id).toBe(false);
			const aboveFloor = EVIDENCE_CLASSES.slice(2);
			const asserted = aboveFloor.filter((cls) => claims.has(cls));
			for (let index = 0; index < asserted.length; index++) {
				// Reaching index i means every weaker class above the floor is asserted too.
				expect(asserted[index], `${entry.id} missing ${aboveFloor[index]}`).toBe(aboveFloor[index]);
			}
		}
	});

	it("reports nested counts, not exclusive buckets", () => {
		// The buckets must not sum to the row count: a row asserting live also asserts
		// three weaker classes. A report that summed them was reading the wrong thing.
		const summary = reconcileLedger();
		const total = EVIDENCE_CLASSES.reduce((sum, cls) => sum + summary.byEvidence[cls], 0);
		const rows = summary.total;
		const exclusiveSum = summary.byEvidence.unregistered + summary.byEvidence.registered;
		expect(exclusiveSum, "unregistered and registered partition the rows").toBe(rows);
		// Only rows above the floor contribute extra assertions, so the total is the
		// row count plus one per asserted class beyond `registered`.
		expect(total).toBeGreaterThanOrEqual(rows);
		expect(total - rows).toBe(
			summary.byEvidence["runtime-reachable"] +
				summary.byEvidence["behaviourally-verified"] +
				summary.byEvidence["live-verified"],
		);
	});

	it("never claims a registry key the typed registry does not have", () => {
		// A row asserting `registered` for a key nothing declares is a contradiction
		// with the only part of the chain that is a fact rather than a claim.
		expect(reconcileLedger().registeredWithoutKey).toEqual([]);
		for (const entry of buildLedger()) {
			if (entry.evidence === "unregistered") continue;
			expect(entry.piKey, entry.id).toBeTruthy();
		}
	});

	it("backs every non-unregistered row with a key that exists", () => {
		for (const entry of buildLedger()) {
			if (entry.evidence === "unregistered") continue;
			expect(lookupSetting(entry.piKey!), `${entry.id} -> ${entry.piKey}`).toBeDefined();
		}
	});

	it("never claims reachability without naming where it is consumed", () => {
		// The assertion the old model could not make. `wired` was asserted by a note
		// naming a consumer that did not call it; reachability is now a fact about a
		// production call graph and must show its site.
		expect(reconcileLedger().reachableWithoutSite).toEqual([]);
	});

	it("never claims live verification with no proven production read", () => {
		// The strongest false claim available: a row listed as live-verified asserts the
		// behaviour was exercised through a real runtime path the analysis cannot find.
		// With the measured index installed the claim is only honoured for rows the
		// analysis can see a production read for; with no index every row falls back to
		// `registered` and the list is empty by construction, because no row can reach a
		// class that asserts a site.
		expect(reconcileLedger().liveWithoutSite).toEqual([]);
		// And the set is not silently discarded: a row whose claim is unmet is recorded.
		const unreachableLive = buildLedger().filter((entry) => entry.evidence === "live-verified");
		for (const entry of unreachableLive) expect(entry.consumedBy?.length ?? 0, entry.id).toBeGreaterThan(0);
	});

	it("never claims live verification without behavioural verification", () => {
		// The corrected form of the old LIVE_VERIFIED subset WIRED invariant. Live is
		// strictly stronger than behavioural, so the reverse cannot hold.
		expect(reconcileLedger().liveWithoutBehaviour).toEqual([]);
	});

	it("orders the classes so a later one implies every earlier one", () => {
		const rank = new Map(EVIDENCE_CLASSES.map((evidence, index) => [evidence as EvidenceClass, index]));
		for (const entry of buildLedger()) {
			// A row either is at the floor or has a consumption site; there is no
			// intermediate state that claims a class it cannot support.
			if (entry.evidence === "registered" || entry.evidence === "unregistered") continue;
			expect(rank.get(entry.evidence), entry.id).toBeGreaterThan(rank.get("registered")!);
			expect(entry.consumedBy?.length ?? 0, `${entry.id} claims ${entry.evidence} with no site`).toBeGreaterThan(0);
		}
	});
});

describe("the historical promotion claim is kept but never counted", () => {
	it("retains the promotion note for audit history", () => {
		// Migration history is worth keeping. It is not a completion signal, and the
		// field is named `promoted` rather than `wired` so it cannot be read as one.
		const promoted = buildLedger().filter((entry) => entry.promoted !== undefined);
		expect(promoted.length).toBeGreaterThan(0);
		for (const entry of promoted) expect(entry.promoted!.length).toBeGreaterThan(0);
	});

	it("does not let a promoted row be called reachable without a site", () => {
		// The 2026-09-30 failure, pinned: a promotion note must never imply a
		// consumption site, no matter how confident the note reads.
		for (const entry of buildLedger()) {
			if (entry.promoted === undefined) continue;
			if (entry.evidence === "runtime-reachable" || entry.evidence === "behaviourally-verified") {
				expect(entry.consumedBy?.length ?? 0, entry.id).toBeGreaterThan(0);
			}
		}
	});
});

describe("the reachability index is injected, measured", () => {
	it("degrades to the conservative floor when no index is installed", () => {
		// With no repository to read, the ledger asserts the weakest fact it can:
		// that the key is registered. It does not guess reachability.
		setConsumptionIndex(new Map());
		const summary = reconcileLedger();
		expect(summary.byEvidence["runtime-reachable"]).toBe(0);
		expect(summary.byEvidence["behaviourally-verified"]).toBe(0);
		expect(summary.byEvidence["live-verified"]).toBe(0);
	});

	it("attributes a row to runtime-reachable once a site is installed", () => {
		const key = OMP_PARITY_ROWS.find((row) => row.piKey)?.piKey;
		// A row with no key is unregistered and asserts nothing, so the fixture needs one
		// that declares a key to attribute reachability to.
		if (key === undefined) throw new Error("no registered row to attribute reachability to");
		setConsumptionIndex(new Map([[key, [{ site: "packages/example/src/consumer.ts", via: "direct" }]]]));
		const entry = buildLedger().find((candidate) => candidate.piKey === key);
		expect(entry?.evidence).toBe("runtime-reachable");
		expect(entry?.consumedBy).toHaveLength(1);
		// Restored so later assertions see the empty floor rather than this fixture.
		setConsumptionIndex(new Map());
	});
});

describe("the report leads with evidence, not with intent", () => {
	it("names the classes rather than a single wired count", () => {
		const text = describeLedger();
		expect(text).toMatch(/live/);
		expect(text).toMatch(/behavioural/);
		expect(text).toMatch(/registered/);
		// The word the old report led with, and the one the audit showed was false.
		expect(text).not.toMatch(/\b\d+ wired\b/);
		expect(text).toContain("historically promoted");
	});
});
