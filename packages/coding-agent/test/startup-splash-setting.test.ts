import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * The animated startup splash is off unless the user asks for it.
 *
 * The reference declares `startup.showSplash` with `default: false`, because there the
 * splash is phase 0 of the setup wizard rather than a per-launch event: the wizard is what a
 * first run gets, and it is not shown again on subsequent launches. Prime Pi had been
 * playing it on *every* launch, spending 2.6s of each session on decoration.
 *
 * The setting is read through the registry, so the typed descriptor, layer precedence and
 * default are authoritative rather than re-implemented here.
 */

const created: string[] = [];

function harness(settings: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "pi-splash-setting-"));
	created.push(root);
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	if (Object.keys(settings).length > 0) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	}
	return { root, agentDir };
}

afterEach(() => {
	for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("startup.showSplash", () => {
	it("defaults to off", () => {
		const { root, agentDir } = harness({});
		expect(SettingsManager.create(root, agentDir).getStartupShowSplash()).toBe(false);
	});

	it("is on when the user opts in", () => {
		const { root, agentDir } = harness({ startup: { showSplash: true } });
		expect(SettingsManager.create(root, agentDir).getStartupShowSplash()).toBe(true);
	});

	it("is on when explicitly disabled nowhere but set false by the user", () => {
		const { root, agentDir } = harness({ startup: { showSplash: false } });
		expect(SettingsManager.create(root, agentDir).getStartupShowSplash()).toBe(false);
	});

	it("lets the project layer override the global layer", () => {
		// Layer precedence belongs to the registry, not to this call site.
		const { root, agentDir } = harness({ startup: { showSplash: false } });
		const projectDir = join(root, ".pi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "settings.json"), JSON.stringify({ startup: { showSplash: true } }));
		const manager = SettingsManager.create(root, agentDir);
		expect(manager.getStartupShowSplash()).toBe(true);
	});
});
