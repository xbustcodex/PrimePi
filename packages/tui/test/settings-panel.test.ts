import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SETTING_TABS, TAB_METADATA, tabIsLabelled } from "../src/overlays/settings-defs.ts";
import { type SettingsHost, SettingsPanel } from "../src/overlays/settings-panel.ts";
import { OMP_PARITY_ROWS } from "../src/overlays/settings-parity-rows.ts";

/**
 * The panel's interaction model, tested against the reference's rules.
 *
 * `describeLines` gives structure without colour, so ordering, focus and
 * grouping are asserted directly, and `handleInput` drives the same state a
 * terminal would. Two facts about the reference shape these tests: the Memory
 * tab's General group holds exactly one row, and a two-column panel shows the
 * *selected* group rather than every group at once.
 */

const THEME = {
	tabLabel: (text: string, selected: boolean) => (selected ? `[${text}]` : text),
	tabIcon: (text: string, selected: boolean) => (selected ? `*${text}*` : text),
	groupHeading: (text: string) => `# ${text}`,
	rowLabel: (text: string, selected: boolean) => (selected ? `> ${text}` : `  ${text}`),
	rowValue: (text: string, selected: boolean) => (selected ? `<${text}>` : text),
	description: (text: string) => `    ${text}`,
	unavailable: (text: string) => `~~${text}~~`,
	cursor: ">",
	hint: (text: string) => `  ${text}`,
	searchMatch: (text: string) => text,
};

function makeHost(overrides: Partial<SettingsHost> = {}): SettingsHost & { writes: { id: string; value: unknown }[] } {
	const values = new Map<string, boolean | string>();
	const writes: { id: string; value: unknown }[] = [];
	return {
		rows: () => OMP_PARITY_ROWS,
		get: (row) => values.get(row.id),
		set: (row, value) => {
			// A row with no consumer refuses the write. That refusal is what makes an
			// unavailable marker honest rather than decorative.
			if (row.status !== "wired") return false;
			values.set(row.id, value);
			writes.push({ id: row.id, value });
			return true;
		},
		unset: (row) => values.delete(row.id),
		display: (row, value) => {
			if (row.secret) return value === undefined ? "(unset)" : "••••";
			return value === undefined ? "(default)" : String(value);
		},
		options: (row) => row.options ?? [],
		visible: () => true,
		writes,
		...overrides,
	};
}

function makePanel(host = makeHost(), options: Record<string, unknown> = {}) {
	return new SettingsPanel({ host, theme: THEME, ...options });
}

describe("the tab bar reproduces the reference", () => {
	it("offers the ten reference tabs, in order", () => {
		assert.deepEqual([...SettingsPanel.tabs()], [...SETTING_TABS]);
		assert.equal(SettingsPanel.tabs().length, 10);
	});

	it("labels the first eight and leaves the rest icon-only", () => {
		// The reference draws labels for the first LABELLED_TAB_COUNT tabs; the
		// screenshots show eight labels and two icon-only tabs.
		assert.equal(SettingsPanel.labelledTabCount(), 8);
		for (let index = 0; index < 8; index++) {
			assert.ok(tabIsLabelled(SETTING_TABS[index]), `${SETTING_TABS[index]} should be labelled`);
		}
		assert.ok(!tabIsLabelled(SETTING_TABS[8]));
		assert.ok(!tabIsLabelled(SETTING_TABS[9]));
	});

	it("renders the leading tab as General, not Appearance", () => {
		assert.equal(TAB_METADATA.appearance.label, "General");
		const bar = makePanel().describeLines(100)[0]?.text ?? "";
		assert.ok(bar.includes("General"));
		assert.ok(!bar.includes("Appearance"));
	});
});

describe("rows keep their reference locations", () => {
	it("shows the backend selector first in the Memory General group", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		const ids = panel
			.describeLines(120)
			.filter((line) => line.kind === "row")
			.map((line) => line.id);
		assert.equal(ids[0], "memory.backend");
	});

	it("shows an unmigrated row as a marker, in its own group", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		// A two-column panel shows the selected group, so Auto-Learn is reached by
		// selecting its group: present and positioned, not absent.
		panel.handleInput("\t");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		assert.equal(panel.state.selectedGroup, "Auto-Learn");
		const autoLearn = panel.describeLines(120).find((line) => line.id === "autolearn.enabled");
		assert.ok(autoLearn, "the unmigrated row must be shown in its own group");
		assert.match(autoLearn?.text ?? "", /unavailable/);
		assert.match(autoLearn?.text ?? "", /Auto-Learn/);
	});

	it("writes only the wired row", () => {
		const host = makeHost();
		const panel = makePanel(host, { initialTab: "memory" });
		// General holds only the wired backend selector.
		panel.handleInput("\r");
		panel.handleInput("\r");
		assert.equal(host.writes.length, 1);
		assert.equal(host.writes[0]?.id, "memory.backend");
	});
});

describe("the wired row behaves", () => {
	it("writes through to the host and reports the change", () => {
		const host = makeHost();
		let change: { id: string; refused: boolean } | undefined;
		const panel = makePanel(host, {
			initialTab: "memory",
			onChange: (event: { row: { id: string }; refused: boolean }) => {
				change = { id: event.row.id, refused: event.refused };
			},
		});
		panel.handleInput("\r");
		assert.equal(panel.state.openSelector, "memory.backend", "a setting with options opens a selector");
		panel.handleInput("\r");
		assert.equal(change?.id, "memory.backend");
		assert.equal(change?.refused, false);
	});

	it("cancels a selector with Esc without closing the panel or writing", () => {
		const host = makeHost();
		const panel = makePanel(host, { initialTab: "memory" });
		panel.handleInput("\r");
		assert.equal(panel.state.openSelector, "memory.backend");
		panel.handleInput("\x1b");
		assert.equal(panel.state.openSelector, null);
		assert.equal(panel.state.closed, false, "Esc in a selector must not close the panel");
		assert.equal(host.writes.length, 0);
	});

	it("moves the selection within a selector and writes the chosen option", () => {
		const host = makeHost();
		const panel = makePanel(host, { initialTab: "memory" });
		panel.handleInput("\r");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		assert.equal(host.writes[0]?.value, "local");
	});
});

describe("keyboard navigation matches the reference model", () => {
	it("moves between tabs with left and right", () => {
		const panel = makePanel();
		assert.equal(panel.state.tab, "appearance");
		panel.handleInput("\x1b[C");
		assert.equal(panel.state.tab, "model");
		panel.handleInput("\x1b[D");
		assert.equal(panel.state.tab, "appearance");
	});

	it("wraps at the ends rather than stopping", () => {
		const panel = makePanel();
		panel.handleInput("\x1b[D");
		// The last tab is the appended PrimePi one, since the reference's ten keep
		// their order and the addition follows them.
		assert.equal(panel.state.tab, "primepi", "left from the first tab wraps to the last");
	});

	it("moves focus between the columns with Tab", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		assert.equal(panel.state.focus, "rows");
		panel.handleInput("\t");
		assert.equal(panel.state.focus, "groups");
		panel.handleInput("\t");
		assert.equal(panel.state.focus, "rows");
	});

	it("enters the rows when a group is activated", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		panel.handleInput("\t");
		assert.equal(panel.state.focus, "groups");
		panel.handleInput("\r");
		assert.equal(panel.state.focus, "rows", "activating a group moves into it");
	});

	it("keeps the selection inside a single-row group", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		// The reference's Memory General group holds exactly one row, so Down has
		// nowhere to go and correctly wraps to itself.
		const first = panel.state.selectedRow;
		panel.handleInput("\x1b[B");
		assert.equal(panel.state.selectedRow, first);
	});

	it("searches on a printable character and shows the search", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		panel.handleInput("s");
		panel.handleInput("h");
		assert.equal(panel.state.search, "sh");
		assert.ok(
			panel.describeLines(120).some((line) => line.kind === "search"),
			"the search itself must be shown so the mode is visible",
		);
	});

	it("states when a search matches nothing", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		for (const character of "qqqq") panel.handleInput(character);
		assert.ok(
			panel.describeLines(120).some((line) => line.kind === "empty"),
			"a no-match search states so rather than rendering a broken-looking panel",
		);
	});

	it("clears the search with backspace, and Esc clears it before closing", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		panel.handleInput("a");
		panel.handleInput("\x7f");
		assert.equal(panel.state.search, "");
		panel.handleInput("b");
		panel.handleInput("\x1b");
		assert.equal(panel.state.search, "");
		assert.equal(panel.state.closed, false, "Esc must clear the search, not close the panel");
	});

	it("closes on Esc when there is nothing to clear", () => {
		const panel = makePanel();
		panel.handleInput("\x1b");
		assert.equal(panel.state.closed, true);
	});
});

describe("rendering adapts to width", () => {
	it("drops the group column when narrow, as the reference compacts", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		const wide = panel.describeLines(120).filter((line) => line.kind === "group").length;
		const narrow = panel.describeLines(40).filter((line) => line.kind === "group").length;
		assert.ok(wide > 0, "the wide layout shows group headings");
		assert.equal(narrow, 0, "the narrow layout drops them rather than squeezing them");
	});

	it("shows an explicit empty state rather than an apparently broken panel", () => {
		const panel = makePanel(undefined, { initialTab: "memory" });
		for (const character of "zzzz") panel.handleInput(character);
		assert.ok(panel.describeLines(120).some((line) => line.kind === "empty"));
	});

	it("renders a hint line so the keys are discoverable", () => {
		const hint = makePanel()
			.describeLines(100)
			.find((line) => line.kind === "hint");
		assert.ok(hint, "the panel must state its own key model");
		assert.match(hint?.text ?? "", /Esc/);
	});
});

describe("sensitive values never render", () => {
	it("masks a secret row", () => {
		const host = makeHost({ get: (row) => (row.secret ? "super-secret-token" : "value") });
		const panel = makePanel(host, { initialTab: "providers" });
		const rendered = panel.render(120).join("\n");
		assert.ok(!rendered.includes("super-secret-token"), "a sensitive value must not be rendered");
	});
});
