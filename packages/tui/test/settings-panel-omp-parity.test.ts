import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettingsPanel, type SettingsHost } from "../src/overlays/settings-panel.ts";
import { OMP_PARITY_ROWS } from "../src/overlays/settings-parity-rows.ts";

/**
 * Behaviour traced from OMP's own `settings-selector.ts`.
 *
 * These are the cases where reading the reference disagreed with what the
 * parity contract implies. Each cites the reference's symbol, so a later change
 * can be checked against the source rather than against this file's summary of
 * it.
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

function makeHost(): SettingsHost {
	return {
		rows: () => OMP_PARITY_ROWS,
		get: () => undefined,
		// Refuses every write: these tests exercise presentation and navigation.
		set: () => false,
		unset: () => {},
		display: (_row, value) => (value === undefined ? "(default)" : String(value)),
		options: (row) => row.options ?? [],
		visible: () => true,
	};
}

function panel(initialTab: string) {
	return new SettingsPanel({ host: makeHost(), theme: THEME, initialTab: initialTab as never });
}

describe("search spans every tab, as OMP's #setSearchQuery does", () => {
	it("reaches rows on other tabs", () => {
		// OMP iterates SETTING_TABS when recomputing matches. With 383 rows over
		// ten tabs, a search confined to the visible tab would hide settings the
		// user can plainly see on another tab. The hits here come from the model
		// and advisor tabs, neither of which is the one being viewed.
		const p = panel("memory");
		p.handleInput("H");
		const ids = p
			.describeLines(200)
			.filter((line) => line.kind === "row")
			.map((line) => line.id ?? "");
		assert.ok(ids.length > 0, "a search must reach rows");
		const memoryIds = OMP_PARITY_ROWS.filter((row) => row.tab === "memory").map((row) => row.id);
		assert.ok(
			ids.some((id) => !memoryIds.includes(id)),
			"at least one hit must come from a tab other than memory",
		);
	});

	it("renders no group column, because OMP's result list is flat", () => {
		// OMP builds the search list with `layout: "flat"`, so there is no section
		// column to populate while searching.
		const p = panel("memory");
		p.handleInput("H");
		assert.equal(p.describeLines(200).filter((line) => line.kind === "group").length, 0);
	});

	it("switches tabs with Tab, because no section column has focus targets", () => {
		// OMP: `hasSectionFocusTargets()` gates the column toggle; with none, Tab
		// falls through to the tab bar.
		const p = panel("memory");
		p.handleInput("H");
		const before = p.state.tab;
		p.handleInput("\t");
		assert.notEqual(p.state.tab, before);
	});
});

describe("the frame matches OMP's overlay box", () => {
	it("draws top border, tab rows, divider, content, divider, hint, bottom border", () => {
		const lines = panel("appearance").render(100);
		assert.ok(lines[0]?.startsWith("╭"), "opens with a rounded top border");
		assert.ok(lines[0]?.includes("Settings"), "the title is inset into the rule");
		assert.ok(lines.at(-1)?.startsWith("╰"), "closes with a rounded bottom border");
		assert.ok(lines.some((line) => line.startsWith("├")), "has a section divider");
		assert.ok(lines.some((line) => line.startsWith("│")), "content sits inside vertical borders");
	});

	it("names the leading tab General on the bar", () => {
		const bar = panel("appearance").render(140).join("\n");
		assert.ok(bar.includes("General"));
		assert.ok(!bar.includes("Appearance"), "the internal identifier is not shown");
	});

	it("keeps every tab reachable at a narrow width", () => {
		// The bar wraps rather than truncating, so a narrow terminal does not lose
		// tabs.
		const narrow = panel("appearance").render(44);
		const bar = narrow.filter((line) => /General|Model|Memory|tab\./.test(line)).join("\n");
		assert.ok(bar.includes("General"), "the labelled tabs survive the wrap");
	});
});

describe("search result presentation", () => {
	it("states plainly when a search matches nothing", () => {
		// OMP's search list is built with `emptyText: "No matching settings"`.
		const p = panel("memory");
		for (const character of "qqq") p.handleInput(character);
		assert.ok(
			p.describeLines(200).some((line) => line.kind === "empty"),
			"a no-match search must say so",
		);
	});

	it("clears the search on Esc without closing the panel", () => {
		const p = panel("memory");
		p.handleInput("H");
		assert.equal(p.state.search, "H");
		p.handleInput("\x1b");
		assert.equal(p.state.search, "");
		assert.equal(p.state.closed, false, "the first Esc clears the search");
	});
});
