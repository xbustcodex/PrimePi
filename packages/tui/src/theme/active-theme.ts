/**
 * Structural view of the active theme, for code inside `tui`.
 *
 * The reference keeps its `Theme` class in `pi-tui`. Prime Pi's lives in coding-agent, because
 * that is where the colour resolution and the `#RRGGBBAA` parsing fixes are - Prime Pi's
 * stronger authority, and not something this migration replaces.
 *
 * A ported OMP surface inside `tui` needs the theme but must not import coding-agent: that would
 * invert the package dependency and make `pi-tui` unusable on its own. So the theme publishes
 * itself here whenever it is installed, and tui reads it through the narrow contract below.
 *
 * Only `fg()`, `bg()`, `getFgAnsi()` and `getBgAnsi()` are exposed, because that is all the
 * ported surfaces call. Widening this is a deliberate decision, not a convenience.
 */

import type { ThemeBg, ThemeColor } from "./tokens.ts";

/** The box glyphs a bordered surface needs. */
export interface BoxSymbols {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
	readonly teeDown: string;
	readonly teeUp: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly cross: string;
}

/** The theme surface `tui` code is allowed to depend on. */
export interface ThemeSource {
	fg(color: ThemeColor, text: string): string;
	bg(color: ThemeBg, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	/** Precomputed SGR sequence for a foreground token, for reverse colour lookup. */
	getFgAnsi(color: ThemeColor): string;
	/** A foreground escape that contrasts against `fill`, for a fill of unknown luminance. */
	getContrastFgAnsi(fill: ThemeColor): string;
	/** A background applied across the text, surviving resets inside it. */
	bgFill(color: ThemeBg, text: string): string;
	/** Reverse video, for a caret or a selection highlight. */
	inverse(text: string): string;
	/** The token's colour as the terminal actually resolved it, for luminance maths. */
	fgResolved(color: ThemeColor): string;
	/** A foreground chosen to stay legible on `background`, applied across the text. */
	fgOnBg(color: ThemeColor, background: ThemeBg, text: string): string;
	getBgAnsi(color: ThemeBg): string;
	symbol(key: string): string;
	/**
	 * Box glyph groups.
	 *
	 * Properties rather than methods, matching the reference: a caller draws a border by
	 * reading `theme.boxRound.topLeft` and friends, and the tees/crosses a rounded box reuses
	 * come from `boxSharp` so a theme's sharp-junction overrides still apply.
	 */
	/** Powerline separator glyphs, grouped as the reference exposes them. */
	readonly sep: { readonly powerlineRight: string; readonly powerlineLeft: string; readonly powerlineThin: string };
	/** Tree-drawing glyphs, grouped as the reference exposes them. */
	readonly tree: {
		readonly branch: string;
		readonly last: string;
		readonly vertical: string;
		readonly horizontal: string;
		readonly hook: string;
	};
	readonly boxRound: BoxSymbols;
	readonly boxSharp: BoxSymbols;
	readonly boxDotted: { readonly horizontal: string; readonly vertical: string };
	readonly name?: string;
}

let active: ThemeSource | undefined;

/** @internal Called by the theme module whenever the active theme changes. */
export function setActiveThemeSource(value: ThemeSource | undefined): void {
	active = value;
}

/**
 * The active theme, or `undefined` before one is installed.
 *
 * Callers must handle `undefined`: `tui` can be used with no theme at all, and a ported surface
 * that assumes a theme exists would throw during startup rather than degrade.
 */
export function activeTheme(): ThemeSource | undefined {
	return active;
}

/**
 * The active theme, throwing if there is none.
 *
 * Only for call sites that have already established a theme is active - a render inside an
 * interactive session, where a missing theme is a bug rather than a startup state.
 */
export function requireActiveTheme(): ThemeSource {
	if (!active) throw new Error("Theme not initialized. Call initTheme() first.");
	return active;
}
