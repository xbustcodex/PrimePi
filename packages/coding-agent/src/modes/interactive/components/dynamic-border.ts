import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		// The glyph comes from the active theme rather than a literal, matching the reference:
		// `theme.symbol(key)` is where every OMP component reads its glyphs, so a theme that
		// selects the ascii preset - or overrides this one key - changes what is drawn here.
		const glyph = theme.symbol("boxRound.horizontal") || "─";
		return [this.color(glyph.repeat(Math.max(1, width)))];
	}
}
