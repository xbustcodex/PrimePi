/**
 * Theme barrel for code inside `tui`.
 *
 * The reference keeps its whole theme in `pi-tui` and imports it through a barrel. Prime Pi's
 * `Theme` class lives in coding-agent - where the colour resolution and the `#RRGGBBAA` fixes
 * are - so this barrel publishes the installed theme through {@link requireActiveTheme} instead
 * of re-exporting the class.
 *
 * Every ported chrome and overlay file imports `{ theme }` from here, exactly as it does in the
 * reference, so the import sites do not need rewriting when the rest is ported.
 */

export { activeThemeSymbol, setActiveSymbolTheme } from "./active-symbols.ts";
export { activeTheme, requireActiveTheme, setActiveThemeSource, type ThemeSource } from "./active-theme.ts";
export {
	SPINNER_FRAMES,
	type SpinnerFramesOverride,
	type SpinnerType,
	SYMBOL_PRESETS,
	type SymbolKey,
	type SymbolMap,
	type SymbolPreset,
} from "./symbols.ts";
export { isValidThemeColor, THEME_COLOR_ORDER, type ThemeBg, type ThemeColor, type ThemeToken } from "./tokens.ts";

import { requireActiveTheme, type ThemeSource } from "./active-theme.ts";
import type { ThemeBg, ThemeColor } from "./tokens.ts";

/**
 * The active theme, resolved on use.
 *
 * A `Proxy` rather than a binding: importing this barrel must not require a theme to be
 * installed. `colors.test.ts`, `latex.test.ts` and `terminal-colors.test.ts` all import from the
 * package index, and resolving the theme at module load threw "Theme not initialized" before any
 * of them ran an assertion. The reference's `theme` is itself a proxy with the same property.
 */
export const theme: ThemeSource = new Proxy({} as ThemeSource, {
	get(_target, property) {
		const active = requireActiveTheme();
		const value = active[property as keyof ThemeSource];
		return typeof value === "function" ? value.bind(active) : value;
	},
});

/**
 * The active theme, as a type.
 *
 * Ported files name `Theme` because that is what the reference calls it. Here it is an alias of
 * {@link ThemeSource}: the same surface, reached through the mirror rather than a class.
 */
export type Theme = ThemeSource;

/**
 * Foreground colour when `color` is set, otherwise the text unchanged.
 *
 * Ported from the reference: a span carrying no explicit colour inherits the surrounding text
 * rather than being forced to the default foreground.
 */
export function fgOrPlain(color: ThemeColor | undefined, text: string): string {
	return color ? theme.fg(color, text) : text;
}

/** Background colour when `color` is set, otherwise the text unchanged. */
export function bgOrPlain(color: ThemeBg | undefined, text: string): string {
	return color ? theme.bg(color, text) : text;
}
