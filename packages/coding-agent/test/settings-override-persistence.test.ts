import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * `applyOverrides` durability.
 *
 * An override supplied by a caller is a deliberate instruction: the merged view is
 * rebuilt from the persisted layers on every write, so anything not carried
 * forward separately is dropped. That is exactly what used to happen — any later
 * layer write, on any unrelated key, silently undid the override.
 */

function manager(initial: Record<string, unknown> = {}): SettingsManager {
	return SettingsManager.inMemory(initial as never);
}

describe("applied overrides survive a recompute", () => {
	it("survives an unrelated project-layer write", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });
		expect(settings.getSetting("images.blockImages")?.value).toBe(true);

		// Touches a different key in a different layer.
		settings.setSetting("compaction.enabled", false, "project");

		expect(settings.getSetting("images.blockImages")?.value).toBe(true);
	});

	it("survives an unrelated global-layer write", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });

		settings.setSetting("compaction.enabled", false);

		expect(settings.getSetting("images.blockImages")?.value).toBe(true);
	});

	it("survives a reload from storage", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });

		return settings.reload().then(() => {
			expect(settings.getSetting("images.blockImages")?.value).toBe(true);
		});
	});

	it("still reports the override as the source of the value", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });

		expect(settings.getSetting("images.blockImages")?.source).toBe("override");
	});

	it("keeps a later override winning over an earlier one", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });
		settings.applyOverrides({ images: { blockImages: false } });
		expect(settings.getSetting("images.blockImages")?.value).toBe(false);

		settings.setSetting("compaction.enabled", false, "project");
		expect(settings.getSetting("images.blockImages")?.value).toBe(false);
	});

	it("accumulates overrides across separate calls", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });
		settings.applyOverrides({ showHardwareCursor: false });

		settings.setSetting("compaction.enabled", false, "project");

		expect(settings.getSetting("images.blockImages")?.value).toBe(true);
		expect(settings.getSetting("showHardwareCursor")?.value).toBe(false);
	});

	it("leaves a manager with no overrides unaffected", () => {
		const settings = manager({ images: { blockImages: true } });
		settings.setSetting("images.blockImages", false, "project");
		expect(settings.getSetting("images.blockImages")?.value).toBe(false);
	});

	it("lets a project value win once the override is no longer supplied", () => {
		const settings = manager();
		settings.applyOverrides({ images: { blockImages: true } });
		settings.setSetting("images.blockImages", false, "project");
		// The override still outranks the project layer while it is applied.
		expect(settings.getSetting("images.blockImages")?.value).toBe(true);
	});
});
