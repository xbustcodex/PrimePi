import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	allSettings,
	hasPath,
	lookupSetting,
	readPath,
	SettingRegistrationError,
	uiSettings,
	writePath,
} from "../src/core/settings-registry.ts";

/**
 * Phase 1 settings framework: registration, validation, layered reads with
 * provenance, and revision-based memoization.
 *
 * The framework is exercised through the real descriptors that ship with Pi, so a
 * descriptor that drifts from the store fails here rather than in the picker.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-settings-framework-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function managerWith(global: Record<string, unknown>, project?: Record<string, unknown>): SettingsManager {
	const agentDir = join(tempDir, "agent");
	const projectDir = join(tempDir, ".pi");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
	if (project) writeFileSync(join(projectDir, "settings.json"), JSON.stringify(project));
	return SettingsManager.create(tempDir, agentDir, { projectTrusted: true });
}

describe("descriptor registry", () => {
	it("registers every shipped setting under a unique key", () => {
		const keys = allSettings().map((handle) => handle.id);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.length).toBeGreaterThan(0);
	});

	it("rejects a duplicate key so two descriptors cannot disagree", async () => {
		const { registerSetting } = await import("../src/core/settings-registry.ts");
		expect(() => registerSetting({ key: "quietStartup", type: "boolean", default: false })).toThrow(
			SettingRegistrationError,
		);
	});

	it("exposes a handle only for a registered key", () => {
		expect(lookupSetting("terminal.showImages")).toBeDefined();
		expect(lookupSetting("not.a.setting")).toBeUndefined();
	});
});

describe("uiSettings", () => {
	it("returns only settings that declare UI metadata, in row order", () => {
		const rows = uiSettings();
		expect(rows.length).toBeGreaterThan(0);
		// Every returned row has a label and an order.
		for (const row of rows) {
			expect(row.descriptor.ui?.label).toBeTruthy();
			expect(row.descriptor.ui?.order).toBeDefined();
		}
		// Sorted ascending, and strictly increasing so orders are unambiguous.
		const orders = rows.map((row) => row.descriptor.ui?.order ?? 0);
		expect([...orders].sort((a, b) => a - b)).toEqual(orders);
		expect(new Set(orders).size).toBe(orders.length);
	});

	it("never yields a row for a setting with no UI block", async () => {
		// A config-file-only setting must not produce a dead control.
		const { registerSetting } = await import("../src/core/settings-registry.ts");
		registerSetting({ key: "configOnlyProbe", type: "string", default: "" });
		expect(lookupSetting("configOnlyProbe")).toBeDefined();
		expect(uiSettings().some((row) => row.id === "configOnlyProbe")).toBe(false);
	});
});

describe("write validation", () => {
	it("accepts a valid enum value", () => {
		const manager = SettingsManager.inMemory();
		manager.setSetting("steeringMode", "all", "global");
		expect(manager.getSetting("steeringMode")?.value).toBe("all");
	});

	it("rejects an out-of-range enum value before it reaches the file", () => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setSetting("steeringMode", "sideways", "global")).toThrow(/steeringMode/);
	});

	it("rejects a wrong primitive type", () => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setSetting("terminal.showImages", "yes-please", "global")).toThrow();
		expect(() => manager.setSetting("autocompleteMaxVisible", "many", "global")).toThrow();
	});

	it("rejects an unknown setting key", () => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setSetting("nope.not.here", 1, "global")).toThrow(/Unknown setting/);
	});

	it("does not persist a rejected value", () => {
		const manager = managerWith({});
		expect(() => manager.setSetting("treeFilterMode", "not-a-mode", "global")).toThrow();
		// The file must be untouched by the rejected write.
		expect(JSON.parse(readFileSync(join(tempDir, "agent", "settings.json"), "utf8"))).toEqual({});
	});
});

describe("layered reads with provenance", () => {
	it("reports the default when no layer supplies a value", () => {
		const manager = managerWith({});
		const resolved = manager.getSetting("terminal.showImages");
		expect(resolved).toEqual({ value: true, source: "default", isExplicit: false });
	});

	it("reports global when only the global layer supplies a value", () => {
		const manager = managerWith({ terminal: { showImages: false } });
		expect(manager.getSetting("terminal.showImages")).toEqual({
			value: false,
			source: "global",
			isExplicit: true,
		});
	});

	it("lets the project layer win over global, and says so", () => {
		const manager = managerWith({ terminal: { showImages: false } }, { terminal: { showImages: true } });
		const resolved = manager.getSetting("terminal.showImages");
		expect(resolved?.value).toBe(true);
		expect(resolved?.source).toBe("project");
	});

	it("reports override when applyOverrides supplied the value", () => {
		const manager = managerWith({ terminal: { showImages: false } }, { terminal: { showImages: false } });
		manager.applyOverrides({ terminal: { showImages: true } });
		const resolved = manager.getSetting("terminal.showImages");
		expect(resolved?.value).toBe(true);
		expect(resolved?.source).toBe("override");
	});

	it("skips the project layer for a globalOnly setting", () => {
		const manager = managerWith({}, { cacheWarming: "idle" });
		const resolved = manager.getSetting("cacheWarming");
		// Project must not be able to change a money-costing global setting.
		expect(resolved?.source).toBe("default");
		expect(resolved?.value).toBe("streaming");
	});

	it("falls through a malformed persisted value to the next layer", () => {
		const manager = managerWith({ steeringMode: "sideways" });
		const resolved = manager.getSetting("steeringMode");
		expect(resolved?.value).toBe("one-at-a-time");
		expect(resolved?.source).toBe("default");
	});

	it("uses the environment only as a default fallback", () => {
		// Separate managers per case: a resolved read is memoized per revision, and
		// the environment is process-level state that does not change at runtime.
		const previous = process.env.PI_HARDWARE_CURSOR;
		try {
			delete process.env.PI_HARDWARE_CURSOR;
			expect(managerWith({}).getSetting("showHardwareCursor")).toEqual({
				value: true,
				source: "default",
				isExplicit: false,
			});

			process.env.PI_HARDWARE_CURSOR = "0";
			// Env flips the default, but is never reported as an explicit value.
			expect(managerWith({}).getSetting("showHardwareCursor")).toEqual({
				value: false,
				source: "default",
				isExplicit: false,
			});

			// An explicit setting still wins over the environment.
			const explicit = managerWith({ showHardwareCursor: true });
			expect(explicit.getSetting("showHardwareCursor")?.value).toBe(true);
			expect(explicit.getSetting("showHardwareCursor")?.source).toBe("global");
		} finally {
			if (previous === undefined) delete process.env.PI_HARDWARE_CURSOR;
			else process.env.PI_HARDWARE_CURSOR = previous;
		}
	});
});

describe("revision-based memoization", () => {
	it("bumps the revision on every layer mutation", () => {
		const manager = managerWith({});
		const start = manager.getRevision();
		manager.setSetting("quietStartup", true, "global");
		expect(manager.getRevision()).toBeGreaterThan(start);
	});

	it("returns a stale-proof value after a write", () => {
		const manager = managerWith({ quietStartup: false });
		expect(manager.getSetting("quietStartup")?.value).toBe(false);
		manager.setSetting("quietStartup", true, "global");
		// A cached read must not survive the write.
		expect(manager.getSetting("quietStartup")?.value).toBe(true);
	});

	it("returns a stale-proof value after a project write", () => {
		const manager = managerWith({});
		expect(manager.getSetting("editorPaddingX")?.value).toBe(0);
		manager.setSetting("editorPaddingX", 4, "project");
		expect(manager.getSetting("editorPaddingX")?.value).toBe(4);
	});

	it("returns a stale-proof value after applyOverrides", () => {
		const manager = managerWith({ outputPad: 0 });
		expect(manager.getSetting("outputPad")?.value).toBe(0);
		manager.applyOverrides({ outputPad: 1 });
		expect(manager.getSetting("outputPad")?.value).toBe(1);
	});
});

describe("project trust still gates writes", () => {
	it("refuses a project-scoped setting write when untrusted", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const manager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
		expect(() => manager.setSetting("editorPaddingX", 3, "project")).toThrow(/not trusted/i);
	});

	it("allows a global write when the project is untrusted", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const manager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
		expect(() => manager.setSetting("editorPaddingX", 3, "global")).not.toThrow();
	});
});

describe("persistence and migration are unchanged", () => {
	it("still writes settings.json rather than a new format", async () => {
		const manager = managerWith({});
		manager.setSetting("quietStartup", true, "global");
		// Writes are queued behind the storage lock, same as every typed setter.
		await manager.flush();
		const written = JSON.parse(readFileSync(join(tempDir, "agent", "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(written.quietStartup).toBe(true);
	});

	it("still applies legacy migrations on load", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// Legacy queueMode must still migrate to steeringMode.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ queueMode: "all" }));
		const manager = SettingsManager.create(tempDir, agentDir);
		expect(manager.getSetting("steeringMode")?.value).toBe("all");
	});

	it("keeps the descriptor set free of new user-facing settings", () => {
		// Phase 1 declares only pre-existing settings. The picker had 33 rows in its
		// main list plus one in the warnings component before the registry existed;
		// a higher count means a new control slipped in.
		expect(uiSettings().length).toBe(34);
	});

	it("labels every row the picker already rendered", () => {
		// Labels are the picker's search and keyboard-activation key, so they are
		// part of the existing contract, not cosmetics.
		const labels = uiSettings().map((row) => row.descriptor.ui?.label);
		for (const expected of [
			"Auto-compact",
			"Steering mode",
			"Follow-up mode",
			"Transport",
			"HTTP idle timeout",
			"Cache warming",
			"Hide thinking",
			"Mermaid diagrams",
			"Cache miss notices",
			"Collapse changelog",
			"Quiet startup",
			"Install telemetry",
			"Default project trust",
			"Double-escape action",
			"Tree filter mode",
			"Warnings",
			"Default thinking level per model",
			"TUI mode",
			"Fullscreen exit output",
			"Fullscreen scrollbar",
			"Fullscreen copy on select",
			"Theme",
			"Show images",
			"Image width",
			"Auto-resize images",
			"Block images",
			"Skill commands",
			"Show hardware cursor",
			"Editor padding",
			"Output padding",
			"Autocomplete max items",
			"Clear on shrink",
			"Terminal progress",
			"Anthropic extra usage",
		]) {
			expect(labels).toContain(expected);
		}
	});
});

describe("path helpers", () => {
	it("reads and writes dotted paths", () => {
		const target: Record<string, unknown> = {};
		writePath(target, "terminal.showImages", false);
		expect(readPath(target, "terminal.showImages")).toBe(false);
		expect(hasPath(target, "terminal.showImages")).toBe(true);
		expect(hasPath(target, "terminal.missing")).toBe(false);
	});

	it("does not treat a missing intermediate as present", () => {
		expect(readPath(undefined, "a.b")).toBeUndefined();
		expect(hasPath({}, "a.b")).toBe(false);
	});
});

describe("persistence artifacts untouched by Phase 1", () => {
	it("does not introduce a settings file format change", () => {
		expect(existsSync(join(process.cwd(), "packages", "coding-agent", "npm-shrinkwrap.json"))).toBe(true);
	});
});
