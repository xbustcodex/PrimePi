/**
 * The active theme's glyph set, as the pre-token components expect it.
 *
 * `SelectList` and the editor predate the token system and read a whole `SymbolTheme`; this is
 * the bridge. Reading the live theme rather than a snapshot is what makes a theme that overrides
 * `boxRound` change the composer's frame and the list's bullets at the same time.
 */
export function getSymbolTheme(): SymbolTheme {
	const theme = activeTheme();
	if (!theme) return asciiSymbolTheme();
	return {
		cursor: theme.symbol("nav.cursor"),
		inputCursor: theme.symbol("nav.cursor"),
		boxRound: {
			topLeft: theme.symbol("boxRound.topLeft"),
			topRight: theme.symbol("boxRound.topRight"),
			bottomLeft: theme.symbol("boxRound.bottomLeft"),
			bottomRight: theme.symbol("boxRound.bottomRight"),
			horizontal: theme.symbol("boxRound.horizontal"),
			vertical: theme.symbol("boxRound.vertical"),
		},
		boxSharp: {
			topLeft: theme.symbol("boxSharp.topLeft"),
			topRight: theme.symbol("boxSharp.topRight"),
			bottomLeft: theme.symbol("boxSharp.bottomLeft"),
			bottomRight: theme.symbol("boxSharp.bottomRight"),
			horizontal: theme.symbol("boxSharp.horizontal"),
			vertical: theme.symbol("boxSharp.vertical"),
			teeDown: theme.symbol("boxSharp.teeDown"),
			teeUp: theme.symbol("boxSharp.teeUp"),
			teeLeft: theme.symbol("boxSharp.teeLeft"),
			teeRight: theme.symbol("boxSharp.teeRight"),
			cross: theme.symbol("boxSharp.cross"),
		},
		table: {
			topLeft: theme.symbol("table.topLeft"),
			topRight: theme.symbol("table.topRight"),
			bottomLeft: theme.symbol("table.bottomLeft"),
			bottomRight: theme.symbol("table.bottomRight"),
			horizontal: theme.symbol("table.horizontal"),
			vertical: theme.symbol("table.vertical"),
			teeDown: theme.symbol("table.teeDown"),
			teeUp: theme.symbol("table.teeUp"),
			teeLeft: theme.symbol("table.teeLeft"),
			teeRight: theme.symbol("table.teeRight"),
			cross: theme.symbol("table.cross"),
		},
		quoteBorder: theme.symbol("quoteBorder"),
		hrChar: theme.symbol("hrChar"),
		colorSwatch: theme.symbol("color.swatch"),
		spinnerFrames: SPINNER_FRAMES.ascii.status,
	};
}

/**
 * The glyph set before any theme is installed.
 *
 * The ascii preset, which every terminal can draw - a component constructed during startup, before
 * `initTheme`, must still be able to render.
 */
function asciiSymbolTheme(): SymbolTheme {
	const ascii = SYMBOL_PRESETS.ascii;
	// Spelled out rather than built from a prefix: `SymbolMap` is a fixed key union, so a
	// computed key would not typecheck - and an explicit list is also the set of keys a theme
	// may override, which is worth being able to read.
	const group = (
		topLeft: string,
		topRight: string,
		bottomLeft: string,
		bottomRight: string,
		horizontal: string,
		vertical: string,
		teeDown: string,
		teeUp: string,
		teeLeft: string,
		teeRight: string,
		cross: string,
	) => ({
		topLeft,
		topRight,
		bottomLeft,
		bottomRight,
		horizontal,
		vertical,
		teeDown,
		teeUp,
		teeLeft,
		teeRight,
		cross,
	});
	return {
		cursor: ascii["nav.cursor"],
		inputCursor: ascii["nav.cursor"],
		// `boxRound` carries no tees or cross: a rounded box has none, and Unicode has no rounded
		// junction glyph. The table group reuses the sharp junctions because `SymbolMap` declares
		// no `table.*` keys - a table rule is a sharp line.
		boxRound: {
			topLeft: ascii["boxRound.topLeft"],
			topRight: ascii["boxRound.topRight"],
			bottomLeft: ascii["boxRound.bottomLeft"],
			bottomRight: ascii["boxRound.bottomRight"],
			horizontal: ascii["boxRound.horizontal"],
			vertical: ascii["boxRound.vertical"],
		},
		boxSharp: group(
			ascii["boxSharp.topLeft"],
			ascii["boxSharp.topRight"],
			ascii["boxSharp.bottomLeft"],
			ascii["boxSharp.bottomRight"],
			ascii["boxSharp.horizontal"],
			ascii["boxSharp.vertical"],
			ascii["boxSharp.teeDown"],
			ascii["boxSharp.teeUp"],
			ascii["boxSharp.teeLeft"],
			ascii["boxSharp.teeRight"],
			ascii["boxSharp.cross"],
		),
		table: group(
			ascii["boxSharp.topLeft"],
			ascii["boxSharp.topRight"],
			ascii["boxSharp.bottomLeft"],
			ascii["boxSharp.bottomRight"],
			ascii["boxSharp.horizontal"],
			ascii["boxSharp.vertical"],
			ascii["boxSharp.teeDown"],
			ascii["boxSharp.teeUp"],
			ascii["boxSharp.teeLeft"],
			ascii["boxSharp.teeRight"],
			ascii["boxSharp.cross"],
		),
		quoteBorder: ascii["md.quoteBorder"],
		hrChar: ascii["md.hrChar"],
		spinnerFrames: SPINNER_FRAMES.ascii.status,
	};
}

/**
 * The theme a `SelectList` renders with.
 *
 * The reference routes this through `theme/tui-adapters.ts`, a bridge from its `pi-natives` addon.
 * Prime Pi has no native addon, and the addon-backed entry points in that file
 * (`HighlightStream`, `warmHighlighter`, the highlighter itself) have no equivalent to port - so
 * this is the part that is portable and is actually needed: a pure mapping from tokens to
 * stylers.
 *
 * Prime Pi's `SelectListTheme` is five stylers, not the reference's eight. `symbols`, `icon` and
 * `hovered` came with OMP's richer list rows and have no consumer here; adding fields nothing
 * reads would be the same "declared but dead" failure as the unregistered theme defaults.
 *
 * If a future surface needs the highlighter adapter, Prime Pi's implementation is
 * `modes/interactive/theme/theme.ts`'s `highlightCode`, and the bridge belongs in the coding-agent
 * package - which is where the theme lives - rather than here.
 */

import type { SelectListTheme } from "../components/select-list.ts";
import type { SettingsListTheme } from "../components/settings-list.ts";
import type { SymbolTheme } from "../symbols.ts";
import { activeTheme } from "./active-theme.ts";
import { SPINNER_FRAMES, SYMBOL_PRESETS } from "./symbols.ts";

/**
 * The select list's stylers for the active theme.
 *
 * Degrades to unstyled text when no theme is installed: a list drawn with `undefined` colours is
 * worse than a plain one, and a component can legitimately be constructed before startup
 * finishes.
 */
export function getSelectListTheme(): SelectListTheme {
	const theme = activeTheme();
	const identity = (text: string): string => text;
	if (!theme) {
		return {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		};
	}
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

/**
 * The active theme's name, or `undefined` before one is installed.
 *
 * The selector reads this to remember which theme a preview started from, so cancelling can put
 * it back rather than leaving the preview in place.
 */
export function getCurrentThemeName(): string | undefined {
	return activeTheme()?.name;
}

/** The theme a `SettingsList` renders with. */
export function getSettingsListTheme(): SettingsListTheme {
	const theme = activeTheme();
	const identity = (text: string): string => text;
	if (!theme) {
		return { label: identity, value: identity, description: identity, cursor: "> ", hint: identity };
	}
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("text", text)),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("muted", text),
		// A literal marker rather than a themed one: the row is already accented when selected,
		// and colouring the marker too would read as two highlights.
		cursor: theme.fg("accent", "> "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
