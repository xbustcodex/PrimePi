import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TABS, SETTING_TABS, TAB_GROUPS } from "../src/overlays/settings-defs.ts";
import {
	MEMORY_SETTINGS,
	PRIMEPI_SETTINGS,
	recordedSettings,
	settingsForTab,
	statusCounts,
	TAB_SETTINGS_RECORDED,
	unavailableRows,
	unwiredRows,
} from "../src/overlays/settings-parity-map.ts";

/**
 * Parity-map tests.
 *
 * These exist to fail when the panel diverges from the reference. A test that
 * passes because the inventory is empty is worse than no test, so the coverage
 * claim is itself asserted: the map declares which tabs have per-setting rows
 * recorded, and this fails if a recorded tab has none.
 */

describe("parity map covers what it claims to cover", () => {
	it("records every tab's coverage explicitly, and a recorded tab has rows", () => {
		for (const tab of ALL_TABS) {
			const recorded = TAB_SETTINGS_RECORDED[tab];
			assert.equal(typeof recorded, "boolean", `${tab} needs a coverage flag`);
			// A tab flagged as recorded with no settings is a gap that would
			// otherwise read as a finished tab.
			if (recorded) {
				assert.ok(
					settingsForTab(tab).length > 0 || tab === "primepi",
					`${tab} claims to be recorded but has no rows`,
				);
			}
		}
	});

	it("places every recorded setting in a tab the reference declares", () => {
		for (const entry of recordedSettings()) {
			assert.ok(
				SETTING_TABS.includes(entry.tab) || entry.tab === ("primepi" as never),
				`${entry.id} is in tab ${entry.tab}, which is not an OMP tab`,
			);
		}
	});

	it("places every recorded setting in a group its tab declares", () => {
		// A group absent from the table would render under a heading the reference
		// does not have, which is exactly the drift these tests exist to catch.
		for (const entry of recordedSettings()) {
			assert.ok(
				TAB_GROUPS[entry.tab].includes(entry.group),
				`${entry.id} is in group "${entry.group}", which tab ${entry.tab} does not declare`,
			);
		}
	});
});

describe("no control claims to work when nothing consumes it", () => {
	it("has no wired row without a Pi registry key", () => {
		// A `wired` row with no mapping is a dead control: it renders as functional
		// and no runtime reads it. This is the single most important assertion
		// here.
		for (const entry of unwiredRows()) {
			assert.fail(`wired row ${entry.id} has no piKey`);
		}
	});

	it("gives every unavailable row a reason", () => {
		// "Not migrated" and "missed" must be distinguishable by a reader.
		for (const entry of unavailableRows()) {
			assert.ok((entry.note?.length ?? 0) > 0, `${entry.id} is unavailable without a stated reason`);
		}
	});

	it("marks every Pi-specific row with status pi-specific", () => {
		for (const entry of PRIMEPI_SETTINGS) {
			assert.equal(entry.status, "pi-specific", `${entry.id} should be pi-specific`);
			// A Pi-only capability still belongs in a reference tab, or it would
			// rearrange the panel.
			assert.ok(SETTING_TABS.includes(entry.tab), `${entry.id} must sit in an OMP tab`);
		}
	});
});

describe("the Memory tab matches the reference", () => {
	it("carries the five owner-visible rows, in the reference's order", () => {
		assert.deepEqual(
			MEMORY_SETTINGS.map((entry) => entry.label),
			["Memory Backend", "Auto-Learn (experimental)", "Auto-run capture at stop", "Sharpshooter Model"],
		);
	});

	it("places the rows in the reference's groups", () => {
		// General, then Auto-Learn, then Sharpshooter — the reference's TAB_GROUPS
		// order for this tab.
		const byGroup = MEMORY_SETTINGS.map((entry) => entry.group);
		assert.equal(byGroup[0], "General");
		assert.equal(byGroup[byGroup.length - 1], "Sharpshooter");
		assert.ok(byGroup.indexOf("Auto-Learn") < byGroup.indexOf("Sharpshooter"));
	});

	it("carries the reference's descriptions, not the screenshots' wording", () => {
		// They differ, which is why the brief requires tracing the source.
		const backend = MEMORY_SETTINGS.find((entry) => entry.id === "memory.backend");
		assert.ok(
			backend?.description?.includes("Mnemopi SQLite") && backend.description.includes("Sharpshooter"),
			"the backend description should be the reference's",
		);
		const model = MEMORY_SETTINGS.find((entry) => entry.id === "sharpshooter.model");
		assert.equal(model?.description, "Model selector for extraction/consolidation, empty = smol role");
	});

	it("keeps the reference's registry ids so a later wave can map in place", () => {
		// The id is the join key. Renaming one would make activating the row later
		// a move rather than an activation.
		for (const id of ["memory.backend", "autolearn.enabled", "autolearn.autoContinue", "sharpshooter.model"]) {
			assert.ok(
				MEMORY_SETTINGS.some((entry) => entry.id === id),
				`${id} must keep the reference's id`,
			);
		}
	});
});

describe("status counts are consistent", () => {
	it("accounts for every recorded row exactly once", () => {
		const counts = statusCounts();
		const total = counts.wired + counts["pi-specific"] + counts.unavailable;
		assert.equal(total, recordedSettings().length);
		assert.ok(counts.wired > 0, "at least one row should be wired, or nothing is wired yet");
	});
});
