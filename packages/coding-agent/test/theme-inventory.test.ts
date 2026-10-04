import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { getAvailableThemes, getThemeDiagnostics, setTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * The theme inventory is a parity contract, not an implementation detail.
 *
 * The product must carry the complete current OMP theme set, so this pins the count and
 * mechanically checks every migrated file against the reference rather than asserting that
 * "some themes exist". The reference path is only used when the reference tree is present;
 * without it the inventory assertions still run, so the test is meaningful on its own.
 *
 * A theme only counts as migrated when it **loads and applies**. A file that parses but
 * fails to produce a palette is not a theme, which is how `dark-poimandres` and
 * `light-poimandres` were caught: both used `#RRGGBBAA`, a form the colour parser rejected.
 */

const REFERENCE_THEME_DIR = "C:/Users/xkali/new_ai/oh-my-pi/packages/tui/src/theme";

/** `dark`, `light`, and the default set. */
const EXPECTED_INVENTORY = 102;

function referenceAvailable(): boolean {
	return existsSync(join(REFERENCE_THEME_DIR, "dark.json"));
}

/** Absolute paths of every migrated theme file, `dark.json`, `light.json` and the defaults. */
function migratedThemeFiles(): string[] {
	const themesDir = getThemesDir();
	const defaultsDir = join(themesDir, "defaults");
	return [
		...listJson(themesDir).filter(
			(file) => file === join(themesDir, "dark.json") || file === join(themesDir, "light.json"),
		),
		...listJson(defaultsDir),
	];
}

function listJson(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => join(dir, entry));
}

describe("theme inventory", () => {
	it("exposes the complete OMP inventory", () => {
		const available = getAvailableThemes();
		expect(available).toHaveLength(EXPECTED_INVENTORY);
		expect(new Set(available).size).toBe(EXPECTED_INVENTORY);
	});

	it("keeps the dark and light slots, and the documented default dark theme", () => {
		const available = getAvailableThemes();
		expect(available).toContain("dark");
		expect(available).toContain("light");
		// `theme.dark` defaults to "titanium" in the reference, so that name must exist for
		// the default to resolve.
		expect(available).toContain("titanium");
	});

	it("reports no diagnostic while loading the built-ins", () => {
		for (const name of getAvailableThemes()) setTheme(name);
		expect(getThemeDiagnostics()).toEqual([]);
	});

	it("applies every theme in the inventory", () => {
		const failures: string[] = [];
		for (const name of getAvailableThemes()) {
			const result = setTheme(name);
			if (!result.success) failures.push(`${name}: ${result.error ?? "unknown"}`);
		}
		expect(failures).toEqual([]);
	});

	it("matches the reference inventory file-for-file", () => {
		if (!referenceAvailable()) return; // reference tree absent; the count checks still apply
		for (const file of migratedThemeFiles()) {
			const relative = file.slice(getThemesDir().length + 1).replaceAll("\\", "/");
			const mine = JSON.parse(readFileSync(file, "utf8")) as { name: string; colors: Record<string, unknown> };
			const theirs = JSON.parse(readFileSync(join(REFERENCE_THEME_DIR, relative), "utf8")) as {
				name: string;
				colors: Record<string, unknown>;
			};
			expect(mine.name, `${relative} name`).toBe(theirs.name);
			// The token *set* is the contract; values must also match, or the palette has drifted.
			expect(Object.keys(mine.colors).sort(), `${relative} tokens`).toEqual(Object.keys(theirs.colors).sort());
			expect(mine.colors, `${relative} values`).toEqual(theirs.colors);
		}
	});
});
