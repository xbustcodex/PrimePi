/**
 * Colour-blind remapping: make a theme legible without relying on hue alone.
 *
 * ## The problem is one specific pair
 *
 * The overwhelmingly common form of colour-vision deficiency is
 * red-green. A diff that renders additions in green and removals in red is
 * therefore the *worst* possible use of colour: the two things being contrasted
 * are the two a viewer is least able to separate, and every other cue in a
 * terminal diff — the `+` and `-` prefixes — is doing real work only in a
 * renderer that always shows them.
 *
 * So the remap is deliberately narrow. It shifts the addition colour toward
 * blue and touches nothing else. A broad desaturation would help nobody and
 * would cost the theme its identity.
 *
 * ## The shift is a hue rotation, not a swap to a fixed colour
 *
 * Substituting a constant blue would break every theme that has tuned its
 * addition colour for contrast against its own background. Rotating the hue
 * preserves lightness and chroma, so the colour keeps its relationship to the
 * rest of the palette while moving out of the confusable region.
 *
 * 60° is chosen so a canonical green lands on a canonical blue in the Oklch hue
 * circle, where hue angles are perceptually uniform — unlike HSV, where 60° is
 * an arbitrary fraction of a non-uniform wheel.
 */

/** Hue rotation applied to the addition colour, in Oklch degrees. */
export const COLORBLIND_HUE_SHIFT = 60;

/** A colour in a form the remap can operate on. */
export type RemappableColor = { readonly l: number; readonly c: number; readonly h: number };

export interface ColorBlindOptions {
	/**
	 * Also reduce chroma slightly. Off by default: it helps a viewer who cannot
	 * separate the hues at all, at the cost of a noticeably flatter diff.
	 */
	readonly reduceChroma?: boolean;
	/** Chroma multiplier when `reduceChroma` is on. */
	readonly chromaScale?: number;
}

function wrapHue(hue: number): number {
	// Hue is an angle, so 60 + 300 is the same colour as 60. Without wrapping, a
	// theme whose addition colour is already past 300° would produce a value a
	// renderer may reject.
	const wrapped = hue % 360;
	return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Shifts a colour out of the red-green confusion region.
 *
 * A fully achromatic colour is returned unchanged: with no chroma there is no
 * hue to rotate, and pretending otherwise would tint a neutral grey.
 */
export function remapForColorVision(color: RemappableColor, options: ColorBlindOptions = {}): RemappableColor {
	if (color.c <= 0) return { ...color };
	const { reduceChroma = false, chromaScale = 0.85 } = options;
	return {
		l: color.l,
		c: reduceChroma ? color.c * chromaScale : color.c,
		h: wrapHue(color.h + COLORBLIND_HUE_SHIFT),
	};
}

/**
 * Remaps one named colour in a theme, if the theme defines it.
 *
 * Returns a new object; the input is never modified, because a theme is shared
 * across every window in the process and a mutated one would be remapped twice
 * if two of them applied the setting.
 *
 * A key the theme does not define is left absent rather than filled in: the
 * theme has chosen not to colour that role, and inventing a colour would
 * override that decision.
 */
export function remapThemeColor<T extends Record<string, RemappableColor | undefined>>(
	colors: T,
	key: keyof T & string,
	options: ColorBlindOptions = {},
): T {
	const existing = colors[key];
	if (existing === undefined) return { ...colors };
	return { ...colors, [key]: remapForColorVision(existing, options) };
}
