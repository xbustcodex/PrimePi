import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

/**
 * First-run setup is the product's default entry experience, so it must be on by default.
 *
 * The gate used to require `PI_EXPERIMENTAL=1`, which put onboarding behind a flag nobody
 * sets - a fresh install went straight to an empty prompt. The reference does not gate it
 * that way: it offers `OMP_SKIP_SETUP`, i.e. on by default with an opt-out. This mirrors
 * that with the established `PI_` prefix.
 */

const created: string[] = [];

function freshAgentDir(): { root: string; agentDir: string; settingsPath: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-first-run-"));
	created.push(root);
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	return { root, agentDir, settingsPath: join(agentDir, "settings.json") };
}

afterEach(() => {
	delete process.env.PI_SKIP_SETUP;
	delete process.env[ENV_AGENT_DIR];
	for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("first-run setup gating", () => {
	it("runs by default when settings have never been written", () => {
		const { settingsPath } = freshAgentDir();
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("does not require an experimental flag", () => {
		// The regression that motivated this: onboarding was unreachable by default.
		const { settingsPath } = freshAgentDir();
		delete process.env.PI_EXPERIMENTAL;
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("does not run once settings exist", () => {
		const { agentDir, settingsPath } = freshAgentDir();
		writeFileSync(settingsPath, "{}");
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
		expect(agentDir).toBeTruthy();
	});

	it.each(["1", "true", "TRUE", "yes", "on", "anything-else"])("is skipped by PI_SKIP_SETUP=%s", (value) => {
		process.env.PI_SKIP_SETUP = value;
		const { settingsPath } = freshAgentDir();
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it.each(["0", "false", "no", "", "   "])("is not skipped by PI_SKIP_SETUP=%j, so onboarding still runs", (value) => {
		process.env.PI_SKIP_SETUP = value;
		const { settingsPath } = freshAgentDir();
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("is skipped when a custom agent directory is in use", () => {
		// A custom agent dir means the user manages their own configuration deliberately.
		process.env[ENV_AGENT_DIR] = "/tmp/somewhere-else";
		const { settingsPath } = freshAgentDir();
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
