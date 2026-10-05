import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * One row in a select list.
 *
 * Ported from the reference's interface, which Prime Pi's had truncated to three fields. That
 * truncation is why `native/picker.ts` could not compile: the native picker is where OMP's
 * `disabled`, `confirmation`, `pending` and `state` are actually honoured, and there was nowhere
 * in the Prime Pi list to declare them.
 *
 * Every field below is optional except `value` and `label`, so existing three-field construction
 * sites keep working unchanged.
 */
export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/** Optional type-indicator glyph rendered in an aligned column before the label. */
	icon?: string;
	/** Named icon an OMP terminal draws from its own set, replacing {@link icon} natively. */
	iconName?: string;
	/** Native detail text when it differs from the ANSI {@link description}. */
	nativeDetail?: string;
	/** Live state drawn right-aligned natively ("demo/demo", "off"). */
	state?: string;
	/** Dim hint text shown inline after the cursor when this item is selected. */
	hint?: string;
	/** Disabled rows stay visible but are skipped by navigation and cannot activate. */
	disabled?: boolean;
	/** When set, activation requires a second confirm, and this text becomes the status line. */
	confirmation?: string;
	/** Additional text the default fuzzy filter searches, without rendering it. */
	searchText?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	/** Set once an item carrying `confirmation` has been activated once. */
	private pendingConfirmation: boolean = false;
	/** The filter text, surfaced by {@link pickerView} so the native picker can render it. */
	private searchQuery: string = "";
	private mousePressedIndex: number | undefined;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const { startIndex, endIndex } = this.getVisibleRange();

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.filteredItems.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.selectedIndex = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
			if (this.selectedIndex !== previousIndex) this.notifySelectionChange();
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { startIndex, endIndex } = this.getVisibleRange();
		const itemIndex = startIndex + event.y;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;

		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			if (this.selectedIndex !== itemIndex) {
				this.selectedIndex = itemIndex;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}
		if (event.type === "click") {
			const clickedIndex = this.mousePressedIndex ?? itemIndex;
			this.mousePressedIndex = undefined;
			const changed = this.selectedIndex !== clickedIndex;
			this.selectedIndex = clickedIndex;
			if (changed) this.notifySelectionChange();
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem) this.onSelect?.(selectedItem);
			return { handled: true };
		}
		return undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * The list's state as the native picker needs it.
	 *
	 * The native picker memoises a rendered row on this object, so returning a fresh literal each
	 * call is deliberate: identity change is the cache signal. Present in the reference, whose
	 * picker is the reason this accessor exists.
	 */
	pickerView(): {
		readonly items: readonly SelectItem[];
		readonly selected: string | null;
		/** The row awaiting a second confirm, when `confirmation` armed it. */
		readonly pending: string | null;
		readonly query: string;
		readonly cursor: number;
	} {
		const selected = this.filteredItems[this.selectedIndex];
		return {
			items: this.filteredItems,
			selected: selected?.value ?? null,
			pending: this.pendingConfirmation ? (selected?.value ?? null) : null,
			query: this.searchQuery,
			cursor: this.selectedIndex,
		};
	}

	/**
	 * Select and activate the item at a visible index, as a click would.
	 *
	 * Disabled items are inert, matching a keyboard navigation: a click that moved the selection
	 * onto a disabled row would make the list respond differently depending on input device.
	 */
	clickItem(index: number): void {
		const item = this.filteredItems[index];
		if (!item || item.disabled) return;
		this.selectedIndex = index;
		this.onSelectionChange?.(item);
		this.onSelect?.(item);
	}

	private getVisibleRange(): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		return {
			startIndex,
			endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
		};
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
