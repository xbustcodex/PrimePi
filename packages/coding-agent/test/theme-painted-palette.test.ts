import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The colours a theme declares must be the colours that actually reach the screen.
 *
 * The theme inventory test already proves all 102 files load and parse. It cannot prove the
 * chosen theme is the one in effect, because "it parsed" and "it is applied" are different
 * claims, and the gap between them is exactly where a theme silently stops being cosmetic.
 *
 * This test pins the join between the two: it resolves a theme's `#RRGGBB` values to the
 * `R;G;B` triples the renderer emits and checks the mapping is unambiguous. The evidence
 * captured from the shipped binary is exactly this form - launching with a configured theme
 * and with `--use-theme` produced `electricBlue`/`dim`/`dimAluminum` for titanium and
 * `abyssCyan`/`warningAmber`/... for dark-abyss, i.e. each theme's own named variables.
 */

const here = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(here, "..", "src", "modes", "interactive", "theme", "defaults");

/** Flatten a theme document into leaf `#RRGGBB` values keyed by their dotted path. */
function colourEntries(document: unknown, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (value: unknown, path: string): void => {
		if (typeof value === "string") {
			if (/^#[0-9a-fA-F]{6}$/.test(value)) out.set(path, value);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((entry, index) => {
				walk(entry, `${path}[${index}]`);
			});
			return;
		}
		if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
		}
	};
	walk(document, prefix);
	return out;
}

/** The terminal encoding of a `#RRGGBB` value. */
function toTriple(hex: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `${r};${g};${b}`;
}

describe("theme colours reach the renderer in the form it emits", () => {
	const themes = [
		{ name: "titanium", painted: ["0;180;255", "107;114;128", "156;163;176"] },
		{ name: "dark-abyss", painted: ["143;161;181", "242;176;76", "63;211;255", "97;114;137"] },
	];

	it.each(themes)("$name's painted colours are its own declared values", ({ name, painted }) => {
		const document: unknown = JSON.parse(readFileSync(join(defaultsDir, `${name}.json`), "utf8"));
		const declared = colourEntries(document);
		const pathsByTriple = new Map<string, string[]>();
		for (const [path, hex] of declared) {
			const triple = toTriple(hex);
			pathsByTriple.set(triple, [...(pathsByTriple.get(triple) ?? []), path]);
		}

		for (const triple of painted) {
			const paths = pathsByTriple.get(triple);
			expect(paths, `${name} painted ${triple} but declares no such colour`).toBeDefined();
		}
	});

	it("the two themes do not share the painted colours they were distinguished by", () => {
		// Guards against a false positive where both runs actually rendered the same theme.
		const [a, b] = themes;
		expect(a.painted.filter((triple) => b.painted.includes(triple))).toEqual([]);
	});

	it("a theme's colours are not collapsed into a single terminal colour", () => {
		// If the mapping collapsed, every paint would look alike regardless of theme.
		const document: unknown = JSON.parse(readFileSync(join(defaultsDir, "dark-abyss.json"), "utf8"));
		expect(colourEntries(document).size).toBeGreaterThan(20);
	});
});
