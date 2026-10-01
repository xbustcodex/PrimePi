/**
 * The tabbed Settings panel.
 *
 * ## This reproduces the reference's panel, it does not redesign it
 *
 * The structure, the ordering and the interaction model come from the OMP
 * reference at `eabd6b99c6`: `TAB_GROUPS` for the left column, the tab list for
 * the top bar, and the panel behaviour the reference's own overlay implements.
 * Nothing here is a PrimePi preference.
 *
 * The row data comes from the 383-row parity contract, so a row the reference
 * shows and PrimePi cannot yet honour still appears — as a disabled marker at
 * its exact reference location. A panel with holes in it would be structurally
 * different from the reference and would have to be restructured when each
 * subsystem lands. A panel with honest markers is the same panel, honestly
 * labelled, and it activates in place.
 *
 * ## State is not duplicated here
 *
 * The panel holds no settings of its own. Every value is read from and written
 * through the injected {@link SettingsHost}, which is the typed registry's
 * layered store. That is what keeps the stronger internals — validation,
 * layering, source and inheritance, sensitive masking, project trust,
 * effective-change notification — from having to be reimplemented or worked
 * around. The panel is a projection.
 *
 * ## Interaction, and why each key is here
 *
 * - **Left/Right** change tab. The reference is a top-bar tab strip, so a
 *   vertical list would be an invention.
 * - **Tab** moves between the left category column and the right rows, which is
 *   what a two-column layout implies.
 * - **Up/Down** move within the focused column.
 * - **Enter/Space** activate: cycle a boolean or enum in place, open a selector
 *   for a setting that has one.
 * - **Any printable character** starts a search, filtered across the current tab.
 * - **Esc** closes a selector, then clears the search, then closes the panel.
 *   Three levels, because a single level would make a selector impossible to
 *   leave without discarding the panel.
 */

import { visibleWidth } from "../utils.ts";
import {
	ALL_TABS,
	type AnySettingTab,
	LABELLED_TAB_COUNT,
	SETTING_TABS,
	TAB_GROUPS,
	TAB_METADATA,
	tabIsLabelled,
} from "./settings-defs.ts";
import type { ParityRow } from "./settings-parity-rows.ts";

/** A value the panel can display. */
export type DisplayValue = boolean | string;

// Box-drawing glyphs, matching the reference's rounded box set. Pinned here
// rather than imported from a theme, because the installed-build proof
// compares the rendered frame and a theme lookup would make the glyphs depend on
// a colour configuration the proof does not control.
const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeRight: "├",
	teeLeft: "┤",
} as const;

function topBorder(width: number, title: string): string {
	const inner = Math.max(0, width - 2);
	if (!title) return BOX.topLeft + BOX.horizontal.repeat(inner) + BOX.topRight;
	// The title is inset into the rule, as the reference does.
	const shown = ` ${title} `;
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return BOX.topLeft + BOX.horizontal + shown + BOX.horizontal.repeat(fill) + BOX.topRight;
}

function divider(width: number): string {
	return BOX.teeRight + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.teeLeft;
}

function bottomBorder(width: number): string {
	return BOX.bottomLeft + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.bottomRight;
}

function row(content: string, width: number): string {
	// Content is inset by one space on each side, as the reference's row() does.
	const padded = width > 4 ? content.padEnd(Math.max(0, width - 4)) : "";
	return `${BOX.vertical} ${padded} ${BOX.vertical}`;
}
export interface SettingsHost {
	/** Every row the panel may show, in the reference's order. */
	rows(): readonly ParityRow[];
	/** Current effective value for a row, or undefined when unset. */
	get(row: ParityRow): DisplayValue | undefined;
	/** Writes a value. Returns false when the write was refused. */
	set(row: ParityRow, value: DisplayValue): boolean;
	/** Removes an explicit value, so a lower layer or the default applies. */
	unset(row: ParityRow): void;
	/** The value shown for a sensitive row. Must not be the real value. */
	display(row: ParityRow, value: DisplayValue | undefined): string;
	/** Permitted values for a selector. Empty when the row has none. */
	options(row: ParityRow): readonly { value: string; label: string; description?: string }[];
	/** True when a row's condition holds, so it is shown. */
	visible(row: ParityRow): boolean;
}

export interface SettingsPanelTheme {
	tabLabel: (text: string, selected: boolean) => string;
	tabIcon: (text: string, selected: boolean) => string;
	groupHeading: (text: string) => string;
	rowLabel: (text: string, selected: boolean) => string;
	rowValue: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	unavailable: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
	searchMatch: (text: string) => string;
}

/** What changed, so a host can persist and notify. */
export interface SettingsPanelChange {
	readonly row: ParityRow;
	readonly value: DisplayValue;
	/** True when the write was refused by validation. */
	readonly refused: boolean;
}

export interface SettingsPanelOptions {
	readonly host: SettingsHost;
	readonly theme: SettingsPanelTheme;
	/** Where the panel is mounted, for width and resize behaviour. */
	readonly width?: () => number;
	readonly height?: () => number;
	/** Fired on every accepted or refused write. */
	readonly onChange?: (change: SettingsPanelChange) => void;
	/** Fired when the panel closes, with the tab it was on. */
	readonly onClose?: (tab: AnySettingTab) => void;
	readonly initialTab?: AnySettingTab;
}

/** One rendered line, with what it is, so tests can assert on structure. */
export interface SettingsPanelLine {
	readonly kind: "tab" | "group" | "row" | "description" | "hint" | "search" | "empty";
	readonly text: string;
	/** The row or group this line represents. */
	readonly id?: string;
	readonly tab?: AnySettingTab;
	readonly selected?: boolean;
}

/** The panel's observable state, so behaviour can be tested without a terminal. */
export interface SettingsPanelState {
	readonly tab: AnySettingTab;
	readonly focus: "groups" | "rows";
	readonly selectedGroup: string | null;
	readonly selectedRow: string | null;
	/** Open selector for a row, when one is open. */
	readonly openSelector: string | null;
	readonly search: string;
	readonly closed: boolean;
}

/** The number of rows visible before scrolling begins. */
const DEFAULT_VISIBLE_ROWS = 12;

/** The width below which the left column is dropped, matching the reference's compaction. */
const NARROW_WIDTH = 60;

export class SettingsPanel {
	readonly #host: SettingsHost;
	readonly #theme: SettingsPanelTheme;
	readonly #options: SettingsPanelOptions;

	#tab: AnySettingTab;
	#focus: "groups" | "rows" = "rows";
	#groupIndex = 0;
	#rowIndex = 0;
	#selector: { row: ParityRow; index: number } | null = null;
	#search = "";
	#searching = false;
	#closed = false;
	#scrollOffset = 0;

	constructor(options: SettingsPanelOptions) {
		this.#options = options;
		this.#host = options.host;
		this.#theme = options.theme;
		this.#tab = options.initialTab ?? ALL_TABS[0];
	}

	// --- state ---------------------------------------------------------------

	get state(): SettingsPanelState {
		return {
			tab: this.#tab,
			focus: this.#focus,
			selectedGroup: this.#groups()[this.#groupIndex] ?? null,
			selectedRow: this.#visibleRows()[this.#rowIndex]?.row.id ?? null,
			openSelector: this.#selector?.row.id ?? null,
			search: this.#search,
			closed: this.#closed,
		};
	}

	get tab(): AnySettingTab {
		return this.#tab;
	}

	/**
	 * Groups of the current tab, filtered to those with visible rows.
	 *
	 * Empty while searching: a cross-tab result list has no single tab's group
	 * structure, and OMP's flat layout has no group column to populate.
	 */
	#groups(): string[] {
		if (this.#searching || this.#search.length > 0) {
			return [
				...new Set(
					this.#filteredRows()
						.map((row) => row.group)
						.filter((group): group is string => Boolean(group)),
				),
			];
		}
		const rows = this.#filteredRows();
		return TAB_GROUPS[this.#tab].filter((group) => rows.some((row) => (row.group ?? null) === group));
	}

	/**
	 * Rows for the current view, after condition and search filtering.
	 *
	 * A search deliberately spans *every* tab, not the current one: with 383 rows
	 * across ten tabs, a search that only saw the visible tab would miss a setting
	 * the user could see on another tab. OMP's `#setSearchQuery` iterates
	 * `SETTING_TABS` and renders one flat list with a heading per tab, and this
	 * matches that.
	 */
	#filteredRows(): ParityRow[] {
		const needle = this.#search.trim().toLowerCase();
		return this.#host
			.rows()
			.filter((row) => (needle.length === 0 ? row.tab === this.#tab : true))
			.filter((row) => this.#host.visible(row))
			.filter((row) => {
				if (needle.length === 0) return true;
				// Search spans the label, the description and the setting id, because
				// a user who knows a setting's key should be able to type it.
				return (
					row.label.toLowerCase().includes(needle) ||
					(row.description?.toLowerCase().includes(needle) ?? false) ||
					row.id.toLowerCase().includes(needle)
				);
			});
	}

	/** Rows of the currently selected group, with the ungrouped ones first. */
	#visibleRows(): { row: ParityRow; ungrouped: boolean }[] {
		const group = this.#groups()[this.#groupIndex];
		const rows = this.#filteredRows();
		const ungrouped = rows.filter((row) => !row.group);
		const inGroup = rows.filter((row) => row.group === group);
		// A setting the reference does not group renders before any heading, which
		// is the reference's own rule.
		return [
			...ungrouped.map((row) => ({ row, ungrouped: true })),
			...inGroup.map((row) => ({ row, ungrouped: false })),
		];
	}

	// --- interaction ---------------------------------------------------------

	handleInput(data: string): void {
		if (this.#closed) return;

		// A selector captures everything while it is open, so a search keystroke
		// cannot leak into the panel behind it.
		if (this.#selector) {
			this.#handleSelectorInput(data);
			return;
		}

		switch (data) {
			case "\x1b":
				// Three levels, so leaving a selector does not discard the panel.
				if (this.#search.length > 0) {
					this.#search = "";
					this.#searching = false;
					return;
				}
				this.#closed = true;
				this.#options.onClose?.(this.#tab);
				return;
			case "\x1b[C": // right
				this.#moveTab(1);
				return;
			case "\x1b[D": // left
				this.#moveTab(-1);
				return;
			case "\t":
				// Tab moves between the section column and the rows only when the
				// column is present. OMP's rule is the same: a tab with no section
				// targets keeps Tab switching tabs, because there is nothing to move
				// focus to.
				// The column must be *rendered*, not merely non-empty: while
				// searching it is absent, so there is no focus target to move to.
				if (!this.#columnVisible()) {
					this.#moveTab(1);
					return;
				}
				this.#focus = this.#focus === "rows" ? "groups" : "rows";
				return;
			case "\x1b[A": // up
				this.#moveSelection(-1);
				return;
			case "\x1b[B": // down
				this.#moveSelection(1);
				return;
			case "\r":
			case " ":
				this.#activate();
				return;
			case "\x7f":
			case "\b":
				if (this.#searching && this.#search.length > 0) {
					this.#search = this.#search.slice(0, -1);
					this.#resetRowIndex();
					return;
				}
				break;
			default:
				break;
		}

		// Any printable character starts a search, which is what the reference
		// does and what makes a 383-row panel navigable.
		if (data.length === 1 && data >= " " && data !== "\x1b") {
			this.#searching = true;
			this.#search += data;
			this.#resetRowIndex();
		}
	}

	/**
	 * Whether the group column is rendered right now.
	 *
	 * Two independent reasons it is not, and both must gate focus as well as
	 * drawing: a narrow terminal compacts it away, and a search renders a flat
	 * list with no section column at all. Key handling and rendering must ask
	 * the same question, or Tab would move focus to a column nothing draws.
	 */
	#columnVisible(width = this.#options.width?.() ?? 80): boolean {
		if (this.#searching || this.#search.length > 0) return false;
		return width >= NARROW_WIDTH;
	}

	#handleSelectorInput(data: string): void {
		const selector = this.#selector;
		if (!selector) return;
		const options = this.#host.options(selector.row);
		switch (data) {
			case "\x1b":
				this.#selector = null;
				return;
			case "\x1b[A":
				selector.index = (selector.index - 1 + options.length) % Math.max(1, options.length);
				return;
			case "\x1b[B":
				selector.index = (selector.index + 1) % Math.max(1, options.length);
				return;
			case "\r":
			case " ": {
				const option = options[selector.index];
				this.#selector = null;
				if (option) this.#write(selector.row, option.value);
				return;
			}
			default:
				return;
		}
	}

	#moveTab(delta: number): void {
		const index = ALL_TABS.indexOf(this.#tab);
		const next = (index + delta + ALL_TABS.length) % ALL_TABS.length;
		this.#tab = ALL_TABS[next];
		// A tab change resets the cursor: a group index from the previous tab would
		// point at a group that does not exist here.
		this.#groupIndex = 0;
		this.#resetRowIndex();
	}

	#moveSelection(delta: number): void {
		if (this.#focus === "groups") {
			const count = this.#groups().length;
			if (count === 0) return;
			this.#groupIndex = (this.#groupIndex + delta + count) % count;
			this.#resetRowIndex();
			return;
		}
		const count = this.#visibleRows().length;
		if (count === 0) return;
		this.#rowIndex = (this.#rowIndex + delta + count) % count;
	}

	#activate(): void {
		if (this.#focus === "groups") {
			// Activating a group moves into it, which is the two-column behaviour.
			this.#focus = "rows";
			return;
		}
		const entry = this.#visibleRows()[this.#rowIndex];
		if (!entry) return;
		const { row } = entry;
		const options = this.#host.options(row);
		if (options.length > 0) {
			this.#selector = {
				row,
				index: Math.max(
					0,
					options.findIndex((option) => option.value === this.#host.get(row)),
				),
			};
			return;
		}
		// No selector, so the row cycles. A boolean flips; an enum with permitted
		// values advances to the next one.
		if (row.type === "boolean") {
			this.#write(row, this.#host.get(row) !== true);
			return;
		}
		const values = this.#cycleValues(row);
		if (values.length === 0) return;
		const current = this.#host.get(row);
		const at = values.indexOf(typeof current === "string" ? current : "");
		this.#write(row, values[(at + 1) % values.length]);
	}

	#cycleValues(row: ParityRow): string[] {
		if (row.type === "boolean") return [];
		const fromOptions = this.#host.options(row).map((option) => option.value);
		if (fromOptions.length > 0) return fromOptions;
		return [...(row.values ?? [])];
	}

	#write(row: ParityRow, value: DisplayValue): void {
		// A row with no consumer is never written. Presenting a control that
		// changes nothing is the dead-control failure, and a write that appears to
		// succeed while nothing reads the value is worse than no control at all.
		if (row.status !== "wired") {
			this.#options.onChange?.({ row, value, refused: true });
			return;
		}
		const accepted = this.#host.set(row, value);
		this.#options.onChange?.({ row, value, refused: !accepted });
	}

	#resetRowIndex(): void {
		this.#rowIndex = 0;
		this.#scrollOffset = 0;
	}

	// --- rendering -----------------------------------------------------------

	/** The panel's structure, independent of colour. Tests assert on this. */
	describeLines(width: number): SettingsPanelLine[] {
		const lines: SettingsPanelLine[] = [];
		const theme = this.#theme;

		// The tab bar. The reference draws labels for the first LABELLED_TAB_COUNT
		// tabs and icons only for the remainder, which is why the bar is short.
		lines.push({
			kind: "tab",
			text: ALL_TABS.map((tab) => (tabIsLabelled(tab) ? TAB_METADATA[tab].label : TAB_METADATA[tab].icon)).join(
				"  ",
			),
		});
		for (const tab of ALL_TABS) {
			lines.push({
				kind: "tab",
				text: tabIsLabelled(tab) ? TAB_METADATA[tab].label : TAB_METADATA[tab].icon,
				tab,
				selected: tab === this.#tab,
			});
		}

		const groups = this.#groups();
		// The group column is dropped when the terminal is too narrow, and while
		// searching — OMP renders one flat list with a heading per tab and no
		// section column. One predicate serves drawing and key handling, or Tab
		// would move focus to a column nothing draws.
		const showGroups = this.#columnVisible(width);

		if (showGroups) {
			for (const [index, group] of groups.entries()) {
				lines.push({
					kind: "group",
					text: theme.groupHeading(group),
					id: group,
					selected: this.#focus === "groups" && index === this.#groupIndex,
				});
			}
		}

		if (this.#searching || this.#search.length > 0) {
			lines.push({ kind: "search", text: `Search: ${this.#search}` });
		}

		const visible = this.#visibleRows();
		if (visible.length === 0) {
			// An explicit empty state: a tab with nothing matching must say so,
			// rather than rendering as a panel that failed to load.
			lines.push({
				kind: "empty",
				text: this.#search.length > 0 ? "No matching settings." : "No settings in this section.",
			});
		}

		const limit = this.#options.height ? Math.max(3, this.#options.height() - 6) : DEFAULT_VISIBLE_ROWS;
		const window = visible.slice(this.#scrollOffset, this.#scrollOffset + limit);
		let lastGroup: string | null = null;
		for (const [offset, entry] of window.entries()) {
			if (showGroups && !entry.ungrouped && entry.row.group !== lastGroup) {
				lastGroup = entry.row.group ?? null;
				lines.push({ kind: "group", text: theme.groupHeading(lastGroup ?? ""), id: lastGroup ?? undefined });
			}
			const selected = this.#focus === "rows" && this.#scrollOffset + offset === this.#rowIndex;
			lines.push({
				kind: "row",
				text: this.#rowText(entry.row, selected),
				id: entry.row.id,
				selected,
			});
			// The description belongs to the selected row, which is what makes the
			// panel navigable without a second pane.
			if (selected) {
				lines.push({
					kind: "description",
					text: entry.row.description ? theme.description(entry.row.description) : theme.description(""),
					id: entry.row.id,
				});
			}
		}

		if (this.#selector) {
			for (const [index, option] of this.#host.options(this.#selector.row).entries()) {
				lines.push({
					kind: "row",
					text: `${option.label}${option.description ? ` — ${option.description}` : ""}`,
					id: option.value,
					selected: index === this.#selector.index,
				});
			}
		}

		lines.push({
			kind: "hint",
			text: theme.hint("←/→ tab · Tab column · ↑/↓ move · Enter/Space select · type to search · Esc back"),
		});
		return lines;
	}

	#rowText(row: ParityRow, selected: boolean): string {
		const theme = this.#theme;
		// An unavailable row keeps its label, its position and its value, and is
		// marked. Removing it would change the panel's shape; the reference has
		// that row and PrimePi does not yet honour it.
		const suffix = row.status === "wired" || row.status === "pi-specific" ? "" : " (unavailable)";
		const value =
			row.status === "wired" || row.status === "pi-specific" ? this.#host.display(row, this.#host.get(row)) : "—";
		const left = selected ? `${theme.cursor} ` : "  ";
		const body =
			row.status === "wired" || row.status === "pi-specific"
				? theme.rowLabel(row.label, selected)
				: theme.unavailable(row.label + suffix);
		return `${left}${body}  ${theme.rowValue(value, selected)}`;
	}

	/**
	 * The full frame, matching the reference's box layout.
	 *
	 * Top border with an inset title, tab rows, divider, content, divider, hint,
	 * bottom border. A panel without the border is not the reference's panel, so
	 * the glyphs are pinned here rather than left to a host that may not draw
	 * them.
	 */
	#frame(width: number, title: string, body: readonly string[], hint: string, showSearch: boolean): string[] {
		const out: string[] = [topBorder(width, title)];
		for (const line of this.#tabBarLines(width)) out.push(row(line, width));
		out.push(divider(width));
		if (showSearch) out.push(row("", width));
		for (const line of body) out.push(row(line, width));
		out.push(divider(width));
		out.push(row(hint, width));
		out.push(bottomBorder(width));
		return out;
	}

	/** The tab bar as the reference draws it: labels first, then icons. */
	#tabBarLines(width: number): string[] {
		const labelled: string[] = [];
		const icons: string[] = [];
		for (const tab of ALL_TABS) {
			// A label for the first LABELLED_TAB_COUNT tabs and an icon for the
			// rest, which is why the bar shows eight names and two symbols. The split
			// is asserted by the parity test.
			if (tabIsLabelled(tab)) labelled.push(TAB_METADATA[tab].label);
			else icons.push(TAB_METADATA[tab].icon);
		}
		// One line when it fits; otherwise the labelled tabs wrap above the icons,
		// so neither is truncated away at a narrow width.
		const joined = [...labelled, ...icons].join("  ");
		if (visibleWidth(joined) + 4 <= width) return [joined];
		return labelled.length > 0 ? [labelled.join("  "), icons.join("  ")] : [icons.join("  ")];
	}

	/** Rendered output, for the installed-build proof. */
	render(width?: number): string[] {
		const resolved = width ?? this.#options.width?.() ?? 80;
		const lines = this.describeLines(resolved);
		const body = lines.filter((line) => line.kind !== "tab" && line.kind !== "hint").map((line) => line.text);
		const hint = lines.find((line) => line.kind === "hint")?.text ?? "";
		const searching = this.#searching || this.#search.length > 0;
		return this.#frame(resolved, "Settings", body, hint, searching);
	}

	static tabs(): readonly AnySettingTab[] {
		return SETTING_TABS;
	}

	/** The labelled-tab count, so a test can assert the reference's layout rule. */
	static labelledTabCount(): number {
		return LABELLED_TAB_COUNT;
	}
}
