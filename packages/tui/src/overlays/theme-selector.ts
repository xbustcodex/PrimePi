import { OverlayPanel } from "../chrome/overlay-box.ts";
import { routeSelectListMouseWithTopBorder } from "../components/select-list-mouse-routing.ts";
import { type SelectItem, SelectList } from "../index.ts";
import type { SgrMouseEvent } from "../mouse.ts";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node.ts";
import { SelectListSheet, type SelectPickerOptions } from "../native/picker.ts";
import { getSelectListTheme } from "../theme/tui-adapters.ts";

/**
 * Picker options for a theme list (this selector and the settings theme
 * submenu): a swatch `mark` seeded by the theme id, the current theme dotted,
 * `Apply ⏎`. Moving the selection previews through the list's `onSelectionChange`.
 */
export function themePickerOptions(title: string, current: string): SelectPickerOptions {
	return {
		title,
		icon: "ink",
		noun: "themes",
		searchable: true,
		current: [current],
		confirm: "Apply",
		decorate: (item) => ({ mark: { text: item.value.slice(0, 2), seed: item.value } }),
	};
}

/**
 * Component that renders a theme selector.
 * Themes must be pre-loaded and passed to the constructor.
 */
export class ThemeSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;
	#onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super("Theme", "omp.overlay.theme");
		this.#onPreview = onPreview;

		// Create select items from provided themes
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// Create selector
		this.#selectList = new SelectList(themeItems, 10, getSelectListTheme());

		// Preselect current theme
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.#selectList.onSelectionChange = (item) => {
			this.#onPreview(item.value);
		};

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, themePickerOptions("Theme", currentTheme));
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	/**
	 * The event carries its own 0-based row, and this selector draws no top border, so the row
	 * needs no correction before the list sees it.
	 */
	routeMouse(event: SgrMouseEvent): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event);
	}
}
