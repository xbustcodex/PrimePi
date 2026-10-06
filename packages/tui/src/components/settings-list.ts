import { FormField, type FormFieldOptions, type FormFieldTheme } from "../components/form.ts";
import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { MouseRoutable, SgrMouseEvent } from "../mouse.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/**
	 * Marks a row as a section heading rather than a setting.
	 *
	 * A heading row has a label and nothing else: no value, no values, no submenu. The list
	 * renders it as a heading and skips it during navigation, and `applyValue` ignores it.
	 */
	heading?: boolean;
	/** If provided, Enter opens this submenu. Receives current value and done callback.
	 *  done() accepts an optional selectedValue and an optional navigateTo id to move the cursor after close. */
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}

/**
 * The text a settings row is matched against during search.
 *
 * Label, id and current value are always searched; the description and the cycleable values are
 * searched too, because a user looking for "dark" means the theme row and its `light|dark`
 * options rather than a row whose label happens to contain the word.
 *
 * Collapsed to one line: a multi-line description would otherwise let a single row match across a
 * line break and rank against text the user cannot see in the results.
 */
export function getSettingItemFilterText(item: SettingItem): string {
	let text = `${item.label} ${item.id} ${item.currentValue}`;
	if (item.description) text += ` ${item.description}`;
	if (item.values) text += ` ${item.values.join(" ")}`;
	return text.replace(/[\r\n]+/g, " ");
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	/**
	 * The row the pointer is over, which is not the one the cursor is on.
	 *
	 * Optional, and absent by default: a caller that does not track hover renders the same row
	 * either way, which is the previous behaviour.
	 */
	hovered?: (text: string) => string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	/**
	 * Called when the highlighted row changes.
	 *
	 * The settings selector uses it to keep a live preview current while the user arrows through
	 * a list - without it a preview only updates on confirm, which is what a plain settings panel
	 * does and is not what this surface is for.
	 */
	onSelectionChange?: (item: SettingItem) => void;
	enableSearch?: boolean;
	/**
	 * How rows are laid out.
	 *
	 * `flat` puts every row in one column, which is what a *search result* list wants: the results
	 * are grouped by tab in the nav, so repeating a tab heading per row would be noise. The
	 * default renders section headings.
	 */
	layout?: "flat" | "sections";
	/** Whether the list's own search field is active. Off when the surface has one already. */
	typeToSearch?: boolean;
	/** Shown when the filter matches nothing. */
	emptyText?: string;
	/** A hint line under the list. */
	hint?: string;
	/**
	 * Width of the section sidebar, or 0 for no sidebar.
	 *
	 * The search results view shows one; the per-tab view does not, because the tab is already
	 * in the nav and a second grouping column would say the same thing twice.
	 */
	sidebarWidth?: number;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private mousePressedIndex: number | undefined;
	private maxVisible: number;
	/**
	 * Row id for each content line of the last render, so a pointer position can be resolved
	 * back to a row. Rebuilt on every render - a stale map would light the wrong row.
	 */
	/** Which row each rendered line belongs to. A map, not an array: only rendered
	 * lines are ever recorded, and it grows with the frame rather than with the terminal height. */
	private readonly hitRows = new Map<number, string>();

	/** The row the pointer is over, for hover styling. */
	private hoveredItemId: string | null = null;
	/** Whether section-heading jump behaviour is engaged. */
	private sectionFocus = false;
	private onChange: (id: string, newValue: string) => void;
	/** Optional; see {@link SettingsListOptions.onSelectionChange}. */
	private onSelectionChange: ((item: SettingItem) => void) | undefined;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private navigateAfterClose: string | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onSelectionChange = options.onSelectionChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/** Move selection to the item with the given id (no-op if not found). */
	selectItem(id: string): void {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		const index = items.findIndex((i) => i.id === id);
		if (index !== -1) {
			this.selectedIndex = index;
		}
	}

	/**
	 * The row the user has highlighted, if any.
	 *
	 * The settings selector needs this to apply a change to the row the user is actually on,
	 * which is not always the row a submenu was opened from.
	 */
	/**
	 * The index of a row within the currently filtered rows, or -1.
	 *
	 * Reported rather than taken so a caller addressing a row by id does not have to know
	 * whether the list is filtered - the two differ once a search is active.
	 */
	indexOf(id: string): number {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		return items.findIndex((item) => item.id === id);
	}

	getSelectedItem(): SettingItem | undefined {
		return this.filteredItems[this.selectedIndex];
	}

	/** Replace the rows, keeping the selection on the same id when it still exists. */
	setItems(items: readonly SettingItem[]): void {
		const previousId = this.getSelectedItem()?.id;
		this.items = [...items];
		// Re-filter with the current query rather than resetting it: replacing the rows while a
		// search is active should narrow the new rows, not clear the search.
		this.applyFilter(this.searchEnabled ? (this.searchInput?.getValue() ?? "") : "");
		if (previousId !== undefined) {
			const index = this.filteredItems.findIndex((item) => item.id === previousId);
			this.selectedIndex = index >= 0 ? index : 0;
		} else {
			this.selectedIndex = 0;
		}
	}

	/** Whether a submenu is currently open over the list. */
	hasOpenSubmenu(): boolean {
		return this.submenuComponent !== null;
	}

	/** Which row's submenu is open, or `undefined` when none is. */
	openSubmenuFor(): SettingItem | undefined {
		return this.submenuItemIndex === null ? undefined : this.filteredItems[this.submenuItemIndex];
	}

	/**
	 * Open a row's submenu, focusing it.
	 *
	 * `openSubmenu` is the caller-driven path: the reference's selector opens the submenu for a
	 * row it has just navigated to rather than waiting for Enter, so the two agree on what is open.
	 */
	openSubmenu(index: number): boolean {
		const item = this.filteredItems[index];
		if (!item?.submenu) return false;
		const done = (_selectedValue?: string, options?: { navigateTo?: string }) => {
			this.closeSubmenu();
			if (options?.navigateTo) this.selectItem(options.navigateTo);
		};
		this.submenuComponent = item.submenu(item.currentValue, done);
		this.submenuItemIndex = index;
		return true;
	}

	/**
	 * Set a row's value as if the user had cycled it, then report the change.
	 *
	 * The reference's selector drives the list this way rather than writing the value itself, so
	 * the row's displayed value and the change callback cannot disagree. A row with a submenu or
	 * a value outside its permitted set is ignored - the caller is asking for something this row
	 * does not accept.
	 */
	applyValue(id: string, value: string): void {
		const item = this.items.find((candidate) => !candidate.heading && candidate.id === id);
		if (!item || item.submenu || !item.values?.includes(value)) return;
		this.selectItem(id);
		this.items = this.items.map((candidate) =>
			candidate.id === id ? { ...candidate, currentValue: value } : candidate,
		);
		this.applyFilter(this.searchEnabled ? (this.searchInput?.getValue() ?? "") : "");
		this.onChange(item.id, value);
	}

	/**
	 * How many rows the list shows at once.
	 *
	 * The selector sets this from the rows left after its own chrome, so the list fits the
	 * terminal rather than assuming the default.
	 */
	setMaxVisible(rows: number): void {
		const next = Math.max(3, Math.floor(rows));
		if (next === this.maxVisible) return;
		this.maxVisible = next;
	}

	/** The row the pointer is over, resolved against the last rendered frame. */
	hoverTest(line: number, _col: number): string | undefined {
		if (this.submenuComponent) return undefined;
		return this.hitRows.get(line);
	}

	/** Record which row the pointer is over, for hover styling. */
	setHoverItem(id: string | null): void {
		this.hoveredItemId = id;
	}

	/** True while a section heading's jump-to-section behaviour is engaged. */
	get sectionFocused(): boolean {
		return this.sectionFocus;
	}

	/**
	 * Engage or release section focusing.
	 *
	 * Only takes effect when there are section headings to jump between; otherwise it reports
	 * false so the caller knows nothing changed rather than entering a mode with no targets.
	 */
	toggleSectionFocus(): boolean {
		this.sectionFocus = !this.sectionFocus && this.hasSectionFocusTargets();
		return this.sectionFocus;
	}

	/**
	 * Whether there are section headings to jump between.
	 *
	 * Section focusing with nothing to focus would be a mode the user cannot leave by the key
	 * that entered it, so the mode is refused instead.
	 */
	hasSectionFocusTargets(): boolean {
		return this.items.some((item) => item.heading);
	}

	/** The row a pointer position resolves to, from the last rendered frame. */
	hitTest(line: number, _col: number): string | undefined {
		if (this.submenuComponent) return undefined;
		return this.hitRows.get(line);
	}

	/**
	 * Route a mouse event into an open submenu; false when there is none.
	 *
	 * Returns whether the submenu consumed it, so the caller knows not to also act on the row
	 * underneath.
	 */
	routeSubmenuMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		const submenu = this.submenuComponent as (Component & Partial<MouseRoutable>) | null;
		if (!submenu) return false;
		if (submenu.wantsKeyRelease === undefined && !submenu.routeMouse) return false;
		submenu.routeMouse?.(event as never, line, col);
		return true;
	}

	/** Move the selection one step for a wheel notch. */
	handleWheelAt(delta: -1 | 1): void {
		const next = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.onSelectionChange?.(this.filteredItems[next]!);
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): readonly string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Rendered fresh each frame, and reset here rather than where the method starts: the two
		// early returns above can end the frame before any row is drawn, and a stale map would then
		// resolve a pointer against a layout that no longer exists.
		this.hitRows.clear();

		// Calculate visible range with scrolling
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isHovered = this.hoveredItemId !== null && displayItems[i]?.id === this.hoveredItemId;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);
			// Hover is drawn behind the whole row, so it reads as a surface rather than as a
			// recoloured value. Absent a `hovered` styler the row is simply not marked.
			const row = prefix + labelText + separator + valueText;
			const renderedRow = isHovered && this.theme.hovered ? this.theme.hovered(row) : row;

			this.hitRows.set(lines.length, item.id);
			lines.push(truncateToWidth(renderedRow, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenuComponent) {
			const result = this.submenuComponent.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}

		if (this.searchEnabled && this.searchInput) {
			if (event.y === 0) {
				const result = this.searchInput.handleMouse?.(event);
				return result ? { ...result, focus: true } : undefined;
			}
			if (event.y === 1) return undefined;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.selectedIndex = Math.max(0, Math.min(displayItems.length - 1, this.selectedIndex + delta));
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

		const rowOffset = this.searchEnabled ? 2 : 0;
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);
		const itemIndex = startIndex + event.y - rowOffset;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;
		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			this.selectedIndex = itemIndex;
			return { handled: true, focus: true };
		}
		if (event.type === "click") {
			this.selectedIndex = this.mousePressedIndex ?? itemIndex;
			this.mousePressedIndex = undefined;
			this.activateItem();
			return { handled: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayItems = this.getDisplayItems();
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private getDisplayItems(): SettingItem[] {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	private getVisibleRange(displayItems: readonly SettingItem[]): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, displayItems.length) };
	}

	private activateItem(): void {
		const item = this.getDisplayItems()[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(
				item.currentValue,
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					if (selectedValue !== undefined) {
						item.currentValue = selectedValue;
						this.onChange(item.id, selectedValue);
					}
					if (options?.navigateTo) {
						this.navigateAfterClose = options.navigateTo;
					}
					this.closeSubmenu();
				},
			);
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.navigateAfterClose !== null) {
			const id = this.navigateAfterClose;
			this.navigateAfterClose = null;
			this.submenuItemIndex = null;
			this.selectItem(id);
			// Open the target item's submenu automatically
			this.activateItem();
		} else if (this.submenuItemIndex !== null) {
			// Restore selection to the item that opened the submenu
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}

/**
 * Which settings row is being edited inline, if any.
 *
 * A native settings page reports this rather than a boolean: the editing row has to be identified,
 * because the surrounding rows are still rendered while one is in edit.
 */
export interface PrefsEditing {
	/** The row being edited. */
	readonly id: string;
}

/**
 * A `FormField` whose control is a `SettingsList`.
 *
 * Ported from the reference. It lets the settings overlay use the same label / description /
 * hint / footer chrome as every other form while the control itself is the canonical list, so
 * scrolling, filtering and selection behaviour is not reimplemented for the detail view.
 */
export class SettingsFormField extends FormField {
	readonly settingsList: SettingsList;

	constructor(
		options: {
			items: SettingItem[];
			maxVisible: number;
			settingsTheme: SettingsListTheme;
			fieldTheme: FormFieldTheme;
			onChange(id: string, newValue: string): void;
			onCancel(): void;
			listOptions?: SettingsListOptions;
		} & Omit<FormFieldOptions, "theme">,
	) {
		const settingsList = new SettingsList(
			options.items,
			options.maxVisible,
			options.settingsTheme,
			options.onChange,
			options.onCancel,
			options.listOptions,
		);
		super(settingsList, {
			theme: options.fieldTheme,
			label: options.label,
			description: options.description,
			details: options.details,
			previewLabel: options.previewLabel,
			preview: options.preview,
			hint: options.hint,
			summary: options.summary,
			footer: options.footer,
			leadingSpace: options.leadingSpace,
			spaceBeforeControl: options.spaceBeforeControl,
			spaceAfterControl: options.spaceAfterControl,
		});
		this.settingsList = settingsList;
	}
}

/**
 * A stable identifier for a settings section heading.
 *
 * Derived from the heading's text, so the same section keeps the same id across launches - which
 * is what lets a terminal hold view state for it across a re-render.
 */
export function prefsSectionId(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Which settings row is being edited inline, if any.
 *
 * A native settings page reports the row rather than a boolean, because the surrounding rows are
 * still rendered while one is in edit.
 */
export interface PrefsEditing {
	readonly id: string;
}
