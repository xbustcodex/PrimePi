import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	COLORBLIND_HUE_SHIFT,
	type RemappableColor,
	remapForColorVision,
	remapThemeColor,
} from "../src/theme/colorblind.ts";

/**
 * Colour-blind remapping.
 *
 * Two properties carry this. **Only the confusable colour moves** — a broad
 * desaturation would help nobody and cost the theme its identity. And **an
 * achromatic colour is left alone**, because with no chroma there is no hue to
 * rotate and tinting a neutral grey would be a bug, not an accommodation.
 */

const green: RemappableColor = { l: 0.72, c: 0.15, h: 145 };
const grey: RemappableColor = { l: 0.5, c: 0, h: 0 };

describe("the shift is a hue rotation, not a substitution", () => {
	it("rotates the hue by the fixed amount", () => {
		assert.equal(remapForColorVision(green).h, green.h + COLORBLIND_HUE_SHIFT);
	});

	it("preserves lightness", () => {
		// A substitution would break every theme that tuned its addition colour for
		// contrast against its own background.
		assert.equal(remapForColorVision(green).l, green.l);
	});

	it("preserves chroma by default", () => {
		assert.equal(remapForColorVision(green).c, green.c);
	});

	it("moves a canonical green into blue territory", () => {
		// Oklch hue angles are perceptually uniform, so a fixed rotation lands where
		// it is meant to. This is not true of an HSV wheel.
		const remapped = remapForColorVision({ l: 0.7, c: 0.15, h: 145 });
		assert.ok(remapped.h > 180 && remapped.h < 260, `expected blue, got ${remapped.h}`);
	});
});

describe("hue wrapping", () => {
	it("wraps a rotation past 360", () => {
		// A renderer may reject an out-of-range hue, and 60 + 340 is the same colour
		// as 60.
		const remapped = remapForColorVision({ l: 0.6, c: 0.1, h: 340 });
		assert.ok(remapped.h >= 0 && remapped.h < 360, `out of range: ${remapped.h}`);
		assert.equal(remapped.h, 40);
	});
});

describe("an achromatic colour is left alone", () => {
	it("does not tint a neutral grey", () => {
		const remapped = remapForColorVision(grey);
		assert.equal(remapped.c, 0);
		assert.equal(remapped.l, grey.l);
	});

	it("returns a copy rather than the same object", () => {
		assert.notEqual(remapForColorVision(grey), grey);
	});
});

describe("chroma reduction is opt-in", () => {
	it("is off by default", () => {
		assert.equal(remapForColorVision(green, {}).c, green.c);
	});

	it("scales chroma when asked", () => {
		// It helps a viewer who cannot separate the hues at all, at the cost of a
		// flatter diff, so it is not the default.
		assert.equal(remapForColorVision(green, { reduceChroma: true }).c, green.c * 0.85);
	});

	it("honours a custom scale", () => {
		assert.equal(remapForColorVision(green, { reduceChroma: true, chromaScale: 0.5 }).c, green.c * 0.5);
	});
});

describe("a theme is remapped without being mutated", () => {
	const theme = { toolDiffAdded: green, toolDiffRemoved: { l: 0.6, c: 0.12, h: 25 } };

	it("moves only the requested key", () => {
		// A diff rendering additions in green and removals in red is the worst
		// possible use of colour for a red-green deficient viewer.
		const remapped = remapThemeColor(theme, "toolDiffAdded");
		assert.equal(remapped.toolDiffAdded.h, green.h + COLORBLIND_HUE_SHIFT);
		assert.equal(remapped.toolDiffRemoved.h, 25);
	});

	it("does not modify the original", () => {
		// A theme is shared across every window in the process; a mutated one would be
		// remapped twice if two of them applied the setting.
		remapThemeColor(theme, "toolDiffAdded");
		assert.equal(theme.toolDiffAdded.h, green.h);
	});

	it("leaves a key the theme omits undefined rather than inventing a colour", () => {
		// The theme has chosen not to colour that role, so the value stays undefined
		// and no key is added for it.
		const theme = { toolDiffAdded: green, toolDiffRemoved: undefined };
		const remapped = remapThemeColor(theme, "toolDiffRemoved");
		assert.equal(remapped.toolDiffRemoved, undefined);
		// The colour that was present is untouched by remapping a different key.
		assert.equal(remapped.toolDiffAdded.h, green.h);
		// A copy, not the same reference: the shared theme is never handed out.
		assert.ok(remapped !== theme);
	});
});
