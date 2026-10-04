import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Theme selection must go through the documented `theme.dark` / `theme.light` slots.
 *
 * The settings registry declares both slots, and the reference persists and selects through
 * them, but `getThemeSetting()` read only a flat `theme` key. So a user who configured a
 * slot got the built-in default instead, and the settings panel offered choices the startup
 * path never consulted.
 *
 * The slot is chosen from the terminal's reported appearance, matching the reference's
 * order: OSC 11 first (handled by the caller, which has a terminal), then `COLORFGBG`, then
 * a dark fallback. `COLORFGBG` is `<fg>;<bg>` in ncurses order, so the **second** field is
 * the background and index 0-7 is dark, 8+ is light.
 */

const created: string[] = [];

function harness(settings: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "pi-theme-slot-"));
	created.push(root);
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { root, agentDir };
}

afterEach(() => {
	delete process.env.COLORFGBG;
	for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("theme slots", () => {
	it("reads the dark slot when the terminal reports a dark background", () => {
		const { root, agentDir } = harness({ theme: { dark: "dark-abyss", light: "light-frost" } });
		process.env.COLORFGBG = "15;0"; // background index 0 -> dark
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("dark-abyss");
	});

	it("reads the light slot when the terminal reports a light background", () => {
		const { root, agentDir } = harness({ theme: { dark: "dark-abyss", light: "light-frost" } });
		process.env.COLORFGBG = "0;15"; // background index 15 -> light
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("light-frost");
	});

	it("falls back to the dark slot when appearance cannot be determined", () => {
		const { root, agentDir } = harness({ theme: { dark: "dark-abyss", light: "light-frost" } });
		delete process.env.COLORFGBG;
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("dark-abyss");
	});

	it("uses whichever slot was configured when only one is set", () => {
		const { root, agentDir } = harness({ theme: { dark: "dark-cavern" } });
		process.env.COLORFGBG = "0;15"; // would prefer light, which is not configured
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("dark-cavern");
	});

	it("still honours an existing flat theme value", () => {
		// An existing configuration must keep working; the flat key is the last resort.
		const { root, agentDir } = harness({ theme: "dark-synthwave" });
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("dark-synthwave");
	});

	it("prefers the slots over a flat value when both are present", () => {
		const { root, agentDir } = harness({ theme: { dark: "dark-abyss" } });
		delete process.env.COLORFGBG;
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBe("dark-abyss");
	});

	it("returns undefined when nothing is configured, so the default applies", () => {
		const { root, agentDir } = harness({});
		expect(SettingsManager.create(root, agentDir).getThemeSetting()).toBeUndefined();
	});
});
