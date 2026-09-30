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
	{ name: "editToolSystemPromptContribution", file: "packages/coding-agent/src/core/tools/edit.ts" },
	{ name: "spillOutput", file: "packages/ai/src/utils/output-spill.ts" },
	{ name: "checkEditFreshness", file: "packages/ai/src/utils/edit-guards.ts" },
	{ name: "resolveCompactionLimits", file: "packages/ai/src/utils/compaction-thresholds.ts" },
	{ name: "LspManager", file: "packages/coding-agent/src/core/lsp/manager.ts" },
	{ name: "formatTitle", file: "packages/tui/src/status-line/title.ts" },
	{ name: "admitRequest", file: "packages/ai/src/utils/provider-limits.ts" },
];

/** Symbols established by hand as having no production caller. */
const KNOWN_INERT = [
	{ name: "decideChain", file: "packages/coding-agent/src/core/shell/compound-commands.ts" },
	{ name: "parseApprovalPatterns", file: "packages/coding-agent/src/core/shell/approval-patterns.ts" },
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
	it("does not let the parity ledger vouch for a row", () => {
		// The strongest form of the defect: a claim being used as its own evidence.
		// The ledger's notes name the consumer each setting is supposed to have.
		const entry = flagged((candidate) => candidate.name === "decideChain")[0];
		expect(entry, "decideChain must be reported as having no production reference").toBeDefined();
	});

	it("keeps the parity tables out of the reference corpus entirely", () => {
		// Asserted through behaviour, not through an identifier: the rule was a
		// constant once and is a predicate now, and a test that pins the spelling would
		// fail for a reason that has nothing to do with the detector being correct.
		const ledger = "packages/tui/src/overlays/settings-parity-rows.ts";
		expect(flagged((candidate) => candidate.declaredIn.endsWith("compound-commands.ts"))).not.toEqual([]);
		expect(ledger).toMatch(/parity-rows/);
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
		// the distinction that makes the list actionable.
		const inert = flagged((candidate) => candidate.name === "decideChain")[0]!;
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
