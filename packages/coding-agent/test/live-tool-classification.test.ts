import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	assertToolClassified,
	BUILT_IN_TOOL_TIERS,
	unclassifiedTools,
} from "../src/core/security/tool-classification.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * The live invariant: every tool a real session can actually hand the model is
 * classified, so none escapes approval by being session-scoped.
 *
 * The pre-existing inventory test reads `allToolNames`, which is only the
 * cwd-scoped built-ins. `todo` and `task` are session-scoped and absent from it,
 * so that test alone would not have caught either of them going unclassified.
 * This one asks the session what it actually exposes.
 */
async function withSession(
	settings: Record<string, unknown>,
	fn: (session: AgentSession) => Promise<void>,
): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tool-classification-"));
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.inMemory(settings);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		});
		try {
			await fn(session);
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("live tool classification", () => {
	it("classifies every tool a live session exposes", async () => {
		await withSession({}, async (session) => {
			const live = session.state.tools.map((tool) => tool.name);
			// The set is not empty, or the assertion below would pass vacuously.
			expect(live.length).toBeGreaterThan(0);
			expect(unclassifiedTools(live)).toEqual([]);
			expect(() => assertToolClassified(live)).not.toThrow();
		});
	});

	it("includes the session-scoped delegation tool in the live set", async () => {
		await withSession({}, async (session) => {
			expect([...session.getActiveToolNames()]).toContain("task");
		});
	});

	it("gates task at the same tier as bash, so delegation is not a bypass", async () => {
		// The structural claim: `task` can start a child that runs tools, so it
		// carries the same risk class as the tools it can indirectly reach. A lower
		// tier here would mean a strict mode could still delegate freely.
		expect(BUILT_IN_TOOL_TIERS.task).toBe(BUILT_IN_TOOL_TIERS.bash);
	});

	it("keeps task out of the session when the allow-list excludes it", async () => {
		await withSession({ defaultTools: ["read"] }, async (session) => {
			const live = session.state.tools.map((tool) => tool.name);
			expect(live).toContain("read");
			expect(live).not.toContain("task");
		});
	});
});
