import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		// `startsWith` a joined path rather than a hardcoded "/": on Windows the session
		// file sits under `expectedSessionDir\`, so the POSIX literal asserted a path
		// separator the platform does not use.
		expect(sessionFile?.startsWith(`${expectedSessionDir}${sep}`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		// Forward slashes, because `buildSystemPromptSections` normalises the cwd
		// (`system-prompt.ts:170`) before handing it to the model - a path the model has
		// to read and echo back should not carry the separator of the host that produced
		// it. Asserting the raw `sessionCwd` asserted the un-normalised form, so this only
		// ever held where the host separator already was "/".
		expect(session.systemPrompt).toContain(`<cwd>\n${sessionCwd.replace(/\\/g, "/")}\n</cwd>`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		// The bash tool runs a **POSIX shell** on Windows on purpose — `grep` flags, `&&`
		// chaining, `/dev/null`, and approval patterns written against `rm -rf /tmp/*` all
		// assume it (see core/shell/approval-patterns.ts:9). Git Bash is an MSYS layer with a
		// POSIX view of the filesystem, so its `pwd` answers in that view. Probed directly:
		//
		//     Git Bash  pwd     ->  "/tmp/pi-msys-probe"
		//     Git Bash  pwd -W  ->  "C:/Users/xkali/AppData/Local/Temp/pi-msys-probe"
		//
		// Both are correct, and `realpathSync` cannot bridge them because the POSIX spelling is
		// not a Windows path. So the guarantee asserted here is the one that actually holds:
		// the tool runs in the directory the session was created with, in whichever view the
		// shell uses. On POSIX that is a string comparison; on Windows the shell is the only
		// component that knows the mapping, so it is asked.
		const reported = output.trim();
		if (process.platform === "win32") {
			const windowsForm = await bashTool!.execute("test", { command: "pwd -W" });
			const windowsText = windowsForm.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("")
				.trim();
			// Either spelling is accepted, provided the shell itself agrees they name the same
			// directory. A shell pointed somewhere else fails both ways.
			const candidates = [reported, windowsText].filter((value) => value.length > 0);
			expect(candidates.some((value) => existsSync(value) && realpathSync(value) === realpathSync(sessionCwd))).toBe(
				true,
			);
		} else {
			expect(realpathSync(reported)).toBe(realpathSync(sessionCwd));
		}

		session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
	});
});
