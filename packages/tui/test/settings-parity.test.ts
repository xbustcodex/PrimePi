import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ALL_TABS,
	groupIndex,
	LABELLED_TAB_COUNT,
	MEMORY_BACKEND_OPTIONS,
	PRIMEPI_APPENDED_TAB,
	SETTING_TABS,
	TAB_GROUPS,
	TAB_METADATA,
	tabIsLabelled,
} from "../src/overlays/settings-defs.ts";

/**
 * The parity inventory, as a test.
 *
 * The structure transcribed from OMP is the specification, so a change to it has
 * to be deliberate. These tests fail when the transcription drifts, which is what
 * makes "we match OMP" a checkable claim rather than an assertion in a commit
 * message.
 *
 * They also state the counts the screenshots establish, so an edit that drops a
 * tab or reorders the labelled ones is caught here rather than in a visual diff
 * nobody reads.
 */

describe("tab structure matches the OMP reference", () => {
	it("has exactly the ten tabs the reference declares, in its order", () => {
		// oh-my-pi/packages/tui/src/overlays/settings-defs.ts:20 at eabd6b99c6
		assert.deepEqual(
			[...SETTING_TABS],
			["appearance", "model", "interaction", "context", "memory", "files", "shell", "tools", "tasks", "providers"],
		);
	});

	it("appends PrimePi's tab after every OMP tab, leaving their slice intact", () => {
		// The mechanism by which a Pi-only capability joins the panel. If the OMP
		// slice ever changes length or order, a reference update has landed and
		// this needs re-examination rather than silent acceptance.
		assert.deepEqual(ALL_TABS.slice(0, SETTING_TABS.length), [...SETTING_TABS]);
		assert.equal(ALL_TABS[ALL_TABS.length - 1], PRIMEPI_APPENDED_TAB);
		assert.equal(ALL_TABS.length, SETTING_TABS.length + 1);
	});

	it("labels the first eight tabs and leaves the last two icon-only", () => {
		// The screenshots show eight labels; indices 8 and 9 have no label slot in
		// the reference and render as icons only.
		assert.equal(LABELLED_TAB_COUNT, 8);
		for (const tab of SETTING_TABS.slice(0, 8)) {
			assert.ok(tabIsLabelled(tab), `${tab} should be labelled`);
			assert.ok(TAB_METADATA[tab].label.length > 0, `${tab} needs a label`);
		}
		for (const tab of SETTING_TABS.slice(8)) {
			assert.ok(!tabIsLabelled(tab), `${tab} should be icon-only`);
			// The label is still declared, for accessibility and for a future wider
			// layout.
			assert.ok(TAB_METADATA[tab].label.length > 0, `${tab} needs an accessibility label`);
		}
	});

	it("names the leading tab General, which is the reference's `appearance`", () => {
		// The internal name and the visible label differ, and getting this wrong
		// puts "Appearance" where the panel shows "General".
		assert.equal(TAB_METADATA.appearance.label, "General");
		assert.equal(TAB_METADATA.model.label, "Model");
		assert.equal(TAB_METADATA.memory.label, "Memory");
		assert.equal(TAB_METADATA.tools.label, "Tools");
	});

	it("gives every tab a unique icon key", () => {
		const icons = ALL_TABS.map((tab) => TAB_METADATA[tab].icon);
		for (const tab of ALL_TABS) {
			assert.ok(TAB_METADATA[tab].icon.startsWith("tab."), `${tab} needs a tab.* icon key`);
		}
		// Two tabs sharing an icon would render indistinguishably in the icon-only
		// region.
		assert.equal(new Set(icons).size, icons.length);
	});
});

describe("section groups match the OMP reference", () => {
	it("declares a group list for every tab", () => {
		for (const tab of ALL_TABS) {
			assert.ok(Array.isArray(TAB_GROUPS[tab]), `${tab} needs a group list`);
		}
	});

	it("keeps the reference's group order for the tabs the screenshots show", () => {
		// Transcribed from TAB_GROUPS:52.
		assert.deepEqual(TAB_GROUPS.appearance, ["Theme", "Composer", "Status Line", "Display", "Images"]);
		assert.deepEqual(TAB_GROUPS.model, [
			"Thinking",
			"Sampling",
			"Prompt",
			"Retry & Fallback",
			"Advisor",
			"Prewalk",
			"Vision",
		]);
		assert.deepEqual(TAB_GROUPS.context, ["General", "Compaction", "Rules (TTSR)", "Experimental"]);
		assert.deepEqual(TAB_GROUPS.files, ["Editing", "Reading", "Read Summaries", "LSP"]);
		assert.deepEqual(TAB_GROUPS.shell, ["Bash", "Eval & Runtimes"]);
	});

	it("keeps the Memory tab's group order", () => {
		// The Memory tab is part of the required parity target, and Sharpshooter
		// sits last in the reference.
		assert.deepEqual(TAB_GROUPS.memory, ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"]);
	});

	it("keeps the interaction tab's twelve groups in order", () => {
		assert.deepEqual(TAB_GROUPS.interaction, [
			"Input",
			"Approvals",
			"Notifications",
			"Speech",
			"Collab",
			"Stream",
			"Magic Keywords",
			"Startup & Updates",
			"Power",
			"Agent",
			"Git",
			"Skills",
		]);
	});

	it("has no duplicate group within a tab", () => {
		for (const tab of ALL_TABS) {
			assert.equal(new Set(TAB_GROUPS[tab]).size, TAB_GROUPS[tab].length, `${tab} has a duplicate group`);
		}
	});

	it("sorts an unknown group after every known one, so it cannot displace the reference", () => {
		// A newly added heading must land at the end of its tab, not at the top
		// where it would push the reference's own order down.
		const known = groupIndex("memory", "Sharpshooter");
		const unknown = groupIndex("memory", "Some Future Group");
		assert.ok(unknown > known, `unknown group sorted at ${unknown}, known at ${known}`);
		// An ungrouped setting renders before the first heading.
		assert.equal(groupIndex("memory", undefined), -1);
	});
});

describe("memory backend selector matches the reference", () => {
	it("offers the five backends in the reference's order", () => {
		// The list is positional: a user who has learned it selects by position,
		// so re-ordering is a behavioural regression rather than a cosmetic one.
		assert.deepEqual(
			MEMORY_BACKEND_OPTIONS.map((option) => option.value),
			["off", "local", "hindsight", "mnemopi", "sharpshooter"],
		);
	});

	it("gives every backend a label and a description", () => {
		// The panel shows the description beside the option; one without it would
		// render as a bare row and look broken next to its siblings.
		for (const option of MEMORY_BACKEND_OPTIONS) {
			assert.ok(option.label.length > 0, `${option.value} needs a label`);
			assert.ok((option.description?.length ?? 0) > 0, `${option.value} needs a description`);
		}
	});

	it("uses the visible labels from the screenshots", () => {
		assert.deepEqual(
			MEMORY_BACKEND_OPTIONS.map((option) => option.label),
			["Off", "Local", "Hindsight", "Mnemopi", "Sharpshooter"],
		);
	});
});
