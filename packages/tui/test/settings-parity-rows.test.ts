import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SETTING_TABS, TAB_GROUPS } from "../src/overlays/settings-defs.ts";
import {
	OMP_PARITY_ROW_COUNT,
	OMP_PARITY_ROWS,
	OMP_PARITY_TAB_COUNTS,
	parityStatusCounts,
	rowsForGroup,
	rowsForTab,
	unavailableRows,
} from "../src/overlays/settings-parity-rows.ts";

/**
 * The parity contract's own integrity.
 *
 * These tests are what make "the panel is the reference's panel" enforceable. A
 * lossy extraction, a duplicate id, a row in a group its tab does not declare, or
 * a row claiming to be wired with no registry key all fail here rather than
 * shipping as a quietly smaller panel.
 */

describe("the contract accounts for the whole reference panel", () => {
	it("has the transcribed row count", () => {
		// 383 rows carrying a `ui.tab` at eabd6b99c6, verified by an independent
		// per-tab line count. The number is pinned so a future extraction that
		// loses rows fails rather than shipping a smaller panel.
		assert.equal(OMP_PARITY_ROW_COUNT, 383);
		assert.equal(OMP_PARITY_ROWS.length, OMP_PARITY_ROW_COUNT);
	});

	it("reconciles the per-tab distribution with the source", () => {
		// Independent counts from the reference checkout, tab by tab. A mismatch
		// means the contract no longer describes the reference.
		assert.deepEqual(OMP_PARITY_TAB_COUNTS, {
			appearance: 38,
			model: 55,
			interaction: 48,
			context: 30,
			memory: 30,
			files: 27,
			shell: 17,
			tools: 67,
			tasks: 33,
			providers: 38,
		});
		const total = Object.values(OMP_PARITY_TAB_COUNTS).reduce((sum, count) => sum + count, 0);
		assert.equal(total, OMP_PARITY_ROW_COUNT);
	});

	it("places every row in a tab the panel declares", () => {
		for (const row of OMP_PARITY_ROWS) {
			assert.ok(SETTING_TABS.includes(row.tab as never), `${row.id} is in undeclared tab ${row.tab}`);
		}
	});

	it("has no duplicate setting id", () => {
		// A duplicate would render two rows for one setting, and a reordering
		// attempt to fix that would break the reference's row order.
		const ids = OMP_PARITY_ROWS.map((row) => row.id);
		assert.equal(new Set(ids).size, ids.length, "duplicate setting id in the contract");
	});

	it("gives every row an owner-visible label", () => {
		for (const row of OMP_PARITY_ROWS) {
			assert.ok(row.label.length > 0, `${row.id} has no label`);
		}
	});

	it("places every grouped row in a group its tab declares", () => {
		// A group the tab does not list would render under a heading the reference
		// has never had, which is exactly the structural drift to prevent.
		for (const row of OMP_PARITY_ROWS) {
			if (!row.group) continue;
			const groups = TAB_GROUPS[row.tab as never] as readonly string[];
			assert.ok(
				groups.includes(row.group),
				`${row.id} is in group "${row.group}", which ${row.tab} does not declare`,
			);
		}
	});
});

describe("no row claims to work when nothing consumes it", () => {
	it("gives every wired row a PrimePi registry key", () => {
		// The dead-control assertion at contract scale. A `wired` row with no key
		// renders as functional and no runtime reads it.
		for (const row of OMP_PARITY_ROWS) {
			if (row.status !== "wired") continue;
			assert.ok(row.piKey, `wired row ${row.id} has no piKey`);
		}
	});

	it("gives every unusable row a reason", () => {
		// "Not migrated" and "missed" must be distinguishable by a reader, and by
		// CI. A row with no note is indistinguishable from an oversight.
		for (const row of unavailableRows()) {
			assert.ok((row.note?.length ?? 0) > 0, `${row.id} is ${row.status} with no stated reason`);
		}
	});

	it("accounts for every row exactly once", () => {
		const counts = parityStatusCounts();
		const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
		assert.equal(total, OMP_PARITY_ROW_COUNT);
	});
});

describe("the Memory tab is wired, and the reference's five are not", () => {
	it("wires the backend selector and marks the rest as unmigrated", () => {
		const backend = OMP_PARITY_ROWS.find((row) => row.id === "memory.backend");
		assert.equal(backend?.status, "wired");
		assert.equal(backend?.piKey, "memory.backend");
		assert.equal(backend?.tab, "memory");
		assert.equal(backend?.group, "General");

		// The other three owner-visible rows are recorded, not omitted, and marked
		// as awaiting their runtime.
		for (const id of ["autolearn.enabled", "autolearn.autoContinue", "sharpshooter.model"]) {
			const row = OMP_PARITY_ROWS.find((entry) => entry.id === id);
			assert.ok(row, `${id} must be in the contract`);
			assert.equal(row?.status, "omp-present-unmigrated", `${id} should be recorded as unmigrated`);
		}
	});

	it("carries the reference's backend description, not the screenshots' wording", () => {
		const backend = OMP_PARITY_ROWS.find((row) => row.id === "memory.backend");
		// The screenshots' short labels are the selector's option names. The
		// setting's own description is longer, and the reference is the authority.
		assert.equal(
			backend?.description,
			"Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
		);
	});

	it("carries the reference's selector options in order", () => {
		const backend = OMP_PARITY_ROWS.find((row) => row.id === "memory.backend");
		assert.deepEqual(
			(backend?.options ?? []).map((option) => option.value),
			["off", "local", "hindsight", "mnemopi", "sharpshooter"],
		);
	});

	it("includes the fourth owner-visible row the screenshots do not show", () => {
		// The reference declares `Auto-run capture at stop`; the photographs do
		// not. Following the screenshots alone would have missed it.
		const autoContinue = OMP_PARITY_ROWS.find((row) => row.id === "autolearn.autoContinue");
		assert.ok(autoContinue, "the reference's fourth row must be present");
		assert.equal(autoContinue?.label, "Auto-run capture at stop");
		assert.equal(autoContinue?.group, "Auto-Learn");
	});
});

describe("row order is the reference's declaration order", () => {
	it("returns rows for a tab in a stable order", () => {
		const memory = rowsForTab("memory");
		assert.ok(memory.length > 0);
		// The first row of the General group is the backend selector, which is
		// where the reference places it.
		const general = rowsForGroup("memory", "General");
		assert.equal(general[0]?.id, "memory.backend");
		// Sharpshooter comes after Auto-Learn, per the reference's group order.
		assert.ok(TAB_GROUPS.memory.indexOf("Auto-Learn") < TAB_GROUPS.memory.indexOf("Sharpshooter"));
	});

	it("returns the same rows for the same tab on repeated calls", () => {
		assert.deepEqual(rowsForTab("tools"), rowsForTab("tools"));
	});
});
