import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Effective-value change notification.
 *
 * The distinction these tests pin down is between a *write* and an
 * *effective-value change*. They are not the same event, and conflating them
 * produces a layer that announces changes nobody can observe.
 */

function manager(initial: Record<string, unknown> = {}): SettingsManager {
	return SettingsManager.inMemory(initial as never);
}

describe("onEffectiveChange: basic contract", () => {
	it("announces a value that actually becomes effective", () => {
		const settings = manager();
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		settings.setSetting("compaction.enabled", false);

		expect(seen).toEqual([["compaction.enabled", false]]);
	});

	it("does not announce before the first mutation", () => {
		const settings = manager();
		const seen: string[] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key) => seen.push(key));
		expect(seen).toEqual([]);
	});

	it("does not announce a write that leaves the effective value unchanged", () => {
		const settings = manager();
		settings.setSetting("compaction.enabled", false);
		const seen: string[] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key) => seen.push(key));

		// Writing the same value again is not a change.
		settings.setSetting("compaction.enabled", false);
		expect(seen).toEqual([]);
	});

	it("announces only the watched keys", () => {
		const settings = manager();
		const seen: string[] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key) => seen.push(key));

		settings.setSetting("images.autoResize", false);

		expect(seen).toEqual([]);
	});

	it("watches every registered setting when no keys are given", () => {
		const settings = manager();
		const seen: string[] = [];
		settings.onEffectiveChange(undefined, (key) => seen.push(key));

		settings.setSetting("compaction.enabled", false);

		expect(seen).toContain("compaction.enabled");
	});

	it("ignores a key that is not registered", () => {
		const settings = manager();
		const seen: string[] = [];
		settings.onEffectiveChange(["not.a.real.setting"], (key) => seen.push(key));

		settings.setSetting("compaction.enabled", false);

		expect(seen).toEqual([]);
	});
});

describe("onEffectiveChange: layer visibility", () => {
	it("does not announce a project write hidden behind an override", () => {
		const settings = manager();
		// An override outranks the project layer, so the project value is not
		// observable and must not be announced.
		settings.applyOverrides({ compaction: { enabled: true } });
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		settings.setSetting("compaction.enabled", false, "project");

		expect(seen).toEqual([]);
		expect(settings.getSetting("compaction.enabled")?.value).toBe(true);
	});

	it("announces the revealed value when a lower layer becomes the winner", () => {
		const settings = manager({ compaction: { enabled: true } });
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		// The project layer now outranks the global one.
		settings.setSetting("compaction.enabled", false, "project");

		expect(seen).toEqual([["compaction.enabled", false]]);
	});

	it("announces the value revealed by dropping the project layer", () => {
		const settings = manager({ compaction: { enabled: false } });
		settings.setSetting("compaction.enabled", true, "project");
		expect(settings.getSetting("compaction.enabled")?.value).toBe(true);

		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		// Losing trust discards the project layer, revealing the global value.
		settings.setProjectTrusted(false);

		expect(seen).toEqual([["compaction.enabled", false]]);
	});

	it("announces when trust is granted and a persisted project value becomes effective", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-settings-trust-"));
		try {
			const projectDir = join(dir, "project");
			const agentDir = join(dir, "agent");
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			// `images.blockImages` defaults to false, so the two layers are
			// distinguishable: untrusted sees the default, trusted sees the project.
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ images: { blockImages: true } }));

			const untrusted = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
			expect(untrusted.getSetting("images.blockImages")?.value).toBe(false);

			const seen: [string, unknown][] = [];
			untrusted.onEffectiveChange(["images.blockImages"], (key, value) => seen.push([key, value]));

			untrusted.setProjectTrusted(true);

			expect(seen).toEqual([["images.blockImages", true]]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("onEffectiveChange: records and lists", () => {
	it("announces a record whose membership changed", () => {
		const settings = manager();
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["modelRoles"], (key, value) => seen.push([key, value]));

		settings.setSetting("modelRoles", { smol: "xai/grok-4.5" });

		expect(seen).toEqual([["modelRoles", { smol: "xai/grok-4.5" }]]);
	});

	it("does not announce a record rewritten with identical membership", () => {
		const settings = manager();
		settings.setSetting("modelRoles", { smol: "xai/grok-4.5" });
		const seen: string[] = [];
		settings.onEffectiveChange(["modelRoles"], (key) => seen.push(key));

		// Same entries, different insertion order and object identity.
		settings.setSetting("modelRoles", { smol: "xai/grok-4.5" });

		expect(seen).toEqual([]);
	});

	it("announces a list setting whose contents changed", () => {
		const settings = manager();
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["disabledProviders"], (key, value) => seen.push([key, value]));

		settings.setSetting("disabledProviders", ["openrouter"]);

		expect(seen).toEqual([["disabledProviders", ["openrouter"]]]);
	});

	it("does not announce a list setting rewritten identically", () => {
		const settings = manager();
		settings.setSetting("disabledProviders", ["openrouter"]);
		const seen: string[] = [];
		settings.onEffectiveChange(["disabledProviders"], (key) => seen.push(key));

		settings.setSetting("disabledProviders", ["openrouter"]);

		expect(seen).toEqual([]);
	});

	it("announces a string-list-map setting whose contents changed", () => {
		const settings = manager();
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["retry.fallbackChains"], (key, value) => seen.push([key, value]));

		settings.setSetting("retry.fallbackChains", { smol: ["@tiny"] });

		expect(seen).toEqual([["retry.fallbackChains", { smol: ["@tiny"] }]]);
	});
});

describe("onEffectiveChange: coalescing and disposal", () => {
	it("emits once per logical mutation", () => {
		const settings = manager();
		let calls = 0;
		settings.onEffectiveChange(["compaction.enabled", "images.autoResize"], () => calls++);

		settings.setSetting("compaction.enabled", false);

		expect(calls).toBe(1);
	});

	it("stops notifying after unsubscribe", () => {
		const settings = manager();
		const seen: string[] = [];
		const off = settings.onEffectiveChange(["compaction.enabled"], (key) => seen.push(key));

		settings.setSetting("compaction.enabled", false);
		off();
		settings.setSetting("compaction.enabled", true);

		expect(seen).toEqual(["compaction.enabled"]);
	});

	it("treats a repeated unsubscribe as a no-op", () => {
		const settings = manager();
		const off = settings.onEffectiveChange(["compaction.enabled"], () => {});
		off();
		expect(() => off()).not.toThrow();
	});

	it("releases its snapshot on unsubscribe", () => {
		const settings = manager();
		const off = settings.onEffectiveChange(["compaction.enabled", "images.autoResize"], () => {});
		expect(settings.getEffectiveChangeListenerCount()).toBe(1);
		off();
		expect(settings.getEffectiveChangeListenerCount()).toBe(0);
	});

	it("isolates a throwing listener from the others", () => {
		const settings = manager();
		const seen: string[] = [];
		settings.onEffectiveChange(["compaction.enabled"], () => {
			throw new Error("subscriber failure");
		});
		settings.onEffectiveChange(["compaction.enabled"], (key) => seen.push(key));

		expect(() => settings.setSetting("compaction.enabled", false)).not.toThrow();
		expect(seen).toEqual(["compaction.enabled"]);
	});

	it("does not notify a listener that unsubscribed during the same dispatch", () => {
		const settings = manager();
		const seen: string[] = [];
		let off = (): void => {};
		off = settings.onEffectiveChange(["compaction.enabled"], (key) => {
			seen.push(key);
			off();
		});

		settings.setSetting("compaction.enabled", false);
		settings.setSetting("compaction.enabled", true);

		expect(seen).toEqual(["compaction.enabled"]);
	});

	it("supports several independent listeners on the same key", () => {
		const settings = manager();
		const first: string[] = [];
		const second: string[] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key) => first.push(key));
		settings.onEffectiveChange(["compaction.enabled"], (key) => second.push(key));

		settings.setSetting("compaction.enabled", false);

		expect(first).toEqual(["compaction.enabled"]);
		expect(second).toEqual(["compaction.enabled"]);
	});

	it("seeds a late subscriber so it only sees subsequent changes", () => {
		const settings = manager();
		settings.setSetting("compaction.enabled", false);
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		// Re-writing the same value must not look like a change to the new listener.
		settings.setSetting("compaction.enabled", false);
		expect(seen).toEqual([]);

		settings.setSetting("compaction.enabled", true);
		expect(seen).toEqual([["compaction.enabled", true]]);
	});

	it("notifies when an override is applied on top of the merged view", () => {
		const settings = manager({ compaction: { enabled: true } });
		const seen: [string, unknown][] = [];
		settings.onEffectiveChange(["compaction.enabled"], (key, value) => seen.push([key, value]));

		settings.applyOverrides({ compaction: { enabled: false } });

		expect(seen).toEqual([["compaction.enabled", false]]);
	});
});
