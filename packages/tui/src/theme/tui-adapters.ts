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
import { activeTheme } from "./active-theme.ts";

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
