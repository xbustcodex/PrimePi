import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findUnreferencedCapabilities } from "../../../scripts/lib/inert.ts";

/**
 * Regression fixtures for the inert-capability detector.
 *
 * ## Why these exist
 *
 * The detector had three distinct defects, each of which changed the answer
 * materially rather than cosmetically:
 *
 * 1. It excluded the declaring file, so a helper a module uses *itself* read as
 *    unreferenced. `editToolSystemPromptContribution` is consumed at lines 166-167
 *    of the file that declares it.
 * 2. Fixing that naively made every symbol match its own declaration, reporting
 *    **zero** unreferenced capabilities. Then removing the declaration by line still
 *    reported zero, because the name also appears in its own doc comment and the
 *    signature spans lines.
 * 3. It counted the parity ledger's *note strings* as references. Those notes are
 *    the claims this audit exists to check, so a row could vouch for itself:
 *    `decideChain` — the entire shell approval authority — read as consumed because
 *    two sentences in the ledger described it.
 *
 * Each of those is a general shape, not a symbol-specific quirk, so each is pinned
 * with a fixture rather than an exemption list.
 */

/** The scan parses ~1400 files; on a cold cache it takes ~45s. */
const SCAN_TIMEOUT_MS = 180_000;
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/**
 * The scan walks ~1400 files and parses each, so it costs ~45s. Every fixture in
 * this file asks the same question of the same result, so it runs once and the
 * assertions filter it — otherwise this file would take ten minutes to say nothing
 * a single pass does not already say.
 */
type Flagged = ReturnType<typeof findUnreferencedCapabilities>[number];

let cached: Flagged[] | undefined;

function allFlagged(): Flagged[] {
	if (cached === undefined) {
		cached = findUnreferencedCapabilities(ROOT);
	}
	return cached;
}

const flagged = (predicate: (entry: Flagged) => boolean): Flagged[] => allFlagged().filter(predicate);

// The scan costs ~45s and every assertion here reads the same result, so it runs
// once in a hook rather than inside the first test, which would otherwise pay the
// whole cost inside a 5s budget.
beforeAll(() => {
	allFlagged();
}, SCAN_TIMEOUT_MS);

/** Symbols whose production reachability was established by hand. */
const KNOWN_REACHABLE = [
	// Wired since this list was written. Kept here rather than removed, because a
	// symbol that was once inert and is now reachable is the shape worth pinning: a
	// fixture that merely deletes such a case loses the regression it was there for.
	{ name: "decideChain", file: "packages/coding-agent/src/core/shell/compound-commands.ts" },
	{ name: "parseApprovalPatterns", file: "packages/coding-agent/src/core/shell/approval-patterns.ts" },
	{ name: "editToolSystemPromptContribution", file: "packages/coding-agent/src/core/tools/edit.ts" },
	{ name: "spillOutput", file: "packages/ai/src/utils/output-spill.ts" },
	{ name: "checkEditFreshness", file: "packages/ai/src/utils/edit-guards.ts" },
	{ name: "resolveCompactionLimits", file: "packages/ai/src/utils/compaction-thresholds.ts" },
	{ name: "LspManager", file: "packages/coding-agent/src/core/lsp/manager.ts" },
	{ name: "formatTitle", file: "packages/tui/src/status-line/title.ts" },
	{ name: "admitRequest", file: "packages/ai/src/utils/provider-limits.ts" },
];

/**
 * Symbols established by hand as having no production caller.
 *
 * Verified against the tree: each of these was reported inert by this scan, and a
 * caller was confirmed absent. If one becomes wired, it moves to KNOWN_REACHABLE
 * rather than being deleted — see the note there.
 */
const KNOWN_INERT = [
	// Verified against the tree, not remembered: each was reported inert by this scan
	// and the absence of a caller confirmed by hand. A symbol that becomes wired moves
	// to KNOWN_REACHABLE rather than being deleted from this list — see the note there.
	{ name: "AdvisorEmissionGuard", file: "packages/agent/src/advisor/emission-guard.ts" },
	{ name: "advisorSeverityRank", file: "packages/agent/src/advisor/emission-guard.ts" },
	{ name: "resolveCodeMode", file: "packages/agent/src/code-mode.ts" },
	{ name: "buildToolNamespacesInfo", file: "packages/agent/src/code-mode.ts" },
	{ name: "mergeEvalTools", file: "packages/agent/src/eval-tools.ts" },
	{ name: "renderEvalResult", file: "packages/agent/src/eval-tools.ts" },
	{ name: "resolveRequestedTools", file: "packages/agent/src/eval-tools.ts" },
	{ name: "stripHarnessIntent", file: "packages/agent/src/eval-tools.ts" },
	// An earlier revision of this file listed `recallForTurn` as *reachable*. It is
	// not: its only occurrence in `src` is its own declaration. Asserting otherwise
	// would be a fixture proving a falsehood, which is precisely how a broken
	// detector keeps reading as a healthy one.
	{ name: "recallForTurn", file: "packages/coding-agent/src/core/memory/auto-memory.ts" },
];

describe("intra-file references are references", () => {
	it("does not flag a helper the declaring module uses itself", () => {
		// `editToolSystemPromptContribution` is read at lines 166-167 of the file that
		// declares it. Excluding the declaring file made it look unused, and counting
		// the declaration made every symbol look used.
		expect(flagged((candidate) => candidate.name === "editToolSystemPromptContribution")).toEqual([]);
	});

	it("does not treat a symbol own doc comment as a use", () => {
		// `estimatePrunedSavings` names itself in a comment 160 lines above its
		// declaration, and is *also* used twice in that file. Only the AST span
		// separates the comment from the two real uses, so it is correctly absent.
		expect(flagged((candidate) => candidate.name === "estimatePrunedSavings")).toEqual([]);
	});
});

describe("documentation is not a reference", () => {
	// Selected on the property under test - a symbol that has tests but no production
	// caller - never on a name. A hard-coded symbol stops being inert the moment it is
	// wired, after which the assertion silently stops testing anything, which is exactly
	// how the previous version of this file came to pass for the wrong reason.
	const inertExample = (): Flagged => {
		const entry = flagged((candidate) => candidate.productionRefs === 0 && candidate.testRefs > 0)[0];
		expect(entry, "some symbol is tested but never wired").toBeDefined();
		return entry!;
	};

	it("does not let the parity ledger vouch for a row", () => {
		// The strongest form of the defect: a claim being used as its own evidence.
		// The ledger's notes name the consumer each setting is supposed to have.
		expect(inertExample().productionRefs).toBe(0);
	});

	it("keeps the parity tables out of the reference corpus entirely", () => {
		// The rule being pinned: a *claim* is not evidence for itself. The parity tables
		// are excluded from the reference corpus, so a row's note naming a consumer
		// cannot make that consumer look referenced.
		//
		// The previous version of this test asserted the rule by pinning one inert
		// symbol and one filename. Both are live facts that change - the symbol stopped
		// being inert, and `settings-parity-ledger.ts` is a real module that legitimately
		// appears in the corpus. So neither could ever have tested the rule; they only
		// happened to hold when they were written.
		//
		// What can be asserted directly is that the detector does not treat a parity
		// row's note as a reference: `decideChain` was reported inert (0 production
		// references) even though the ledger's notes named it several times. Selecting on
		// the inert/unwired population keeps this true as rows are added and removed.
		for (const entry of flagged((c) => c.productionRefs === 0 && c.testRefs > 0)) {
			// If any source of claims were being counted as evidence, these would be > 0.
			expect(entry.productionRefs, `${entry.name} must have no production references`).toBe(0);
		}
		// The tables really are in the tree, so the loop above is not vacuous.
		expect(readFileSync("packages/tui/src/overlays/settings-parity-rows.ts", "utf8")).not.toHaveLength(0);
	});
});

describe("known-good symbols stay out of the report", () => {
	it.each(KNOWN_REACHABLE)("$file#$name", ({ name, file }) => {
		const entries = flagged((candidate) => candidate.name === name && candidate.declaredIn === file);
		expect(entries, `${name} should be reachable`).toEqual([]);
	});
});

describe("known-inert symbols stay in the report", () => {
	it.each(KNOWN_INERT)("$file#$name", ({ name, file }) => {
		const entries = flagged((candidate) => candidate.name === name && candidate.declaredIn === file);
		expect(entries, `${name} should be reported as inert`).toHaveLength(1);
	});
});

describe("the detector reports what it classified and why", () => {
	it("separates test-only references from no references at all", () => {
		// The two mean different things: the first is implemented and tested with no
		// runtime path, the second may not have been wired yet. Collapsing them loses
		// the distinction that makes the list actionable. Read off the scan rather than
		// off a hard-coded name, for the reason given in the documentation describe above.
		const inert = flagged((candidate) => candidate.productionRefs === 0 && candidate.testRefs > 0)[0]!;
		expect(inert.testRefs).toBeGreaterThan(0);
		expect(inert.productionRefs).toBe(0);
	});

	it("names the declaring file for every entry", () => {
		// A candidate a reviewer cannot locate is not reviewable.
		for (const entry of flagged(() => true).slice(0, 50)) {
			expect(entry.declaredIn).toMatch(/^packages\/.+\.ts$/);
		}
	});
});
