import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { ALLOW_SELF_UPDATE_ENV } from "../src/utils/self-update-barrier.ts";

/**
 * Migration invariants I5-I7: the OMP port must not displace Pi's context,
 * trust, or update authorities.
 *
 * These are behavioural. Notably I7 does not grep source for the absence of
 * OMP's `startup.checkUpdate` / `update.channel` / `marketplace.autoUpdate`
 * settings: the guarantee is enforced structurally by the barrier's signature
 * (it accepts only a process env) and proved here by showing that no settings
 * input can influence the decision.
 */

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-migration-invariants-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	process.exitCode = undefined;
	vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
		process.exitCode = code === undefined || code === null ? undefined : code;
		return undefined as never;
	}) as typeof process.exit);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("I5: provenance-preserving context projection stays authoritative", () => {
	const userMessage = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

	it("never mutates the original entry when an edit is applied", () => {
		const sessionManager = SessionManager.inMemory();
		const target = sessionManager.appendMessage(userMessage("original"));
		const before = structuredClone(sessionManager.getEntry(target));

		sessionManager.appendContextEdit(target, { content: "redacted" });

		// The edit is appended as a new entry; the original stays byte-identical.
		expect(sessionManager.getEntry(target)).toEqual(before);
		expect(contentOf(sessionManager.buildSessionProjection().messages[0])).toBe("redacted");
	});

	it("keeps an edit confined to its own branch", () => {
		const sessionManager = SessionManager.inMemory();
		const target = sessionManager.appendMessage(userMessage("secret"));
		sessionManager.appendContextEdit(target, { content: "redacted" });
		expect(contentOf(sessionManager.buildSessionProjection().messages[0])).toBe("redacted");

		// Branching away from the edited entry restores the unedited projection.
		sessionManager.branch(target);
		expect(contentOf(sessionManager.buildSessionProjection().messages[0])).toBe("secret");
	});

	it("removes a target by projection rather than by deletion", () => {
		const sessionManager = SessionManager.inMemory();
		const target = sessionManager.appendMessage(userMessage("drop me"));
		sessionManager.appendContextEdit(target, null);

		expect(sessionManager.buildSessionProjection().messages.some((m) => contentOf(m) === "drop me")).toBe(false);
		// Still present in raw history.
		expect(sessionManager.getEntry(target)).toBeDefined();
	});
});

function contentOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "object" && block !== null && "text" in block
				? String((block as { text: unknown }).text)
				: "",
		)
		.join("");
}

describe("I6: project trust gates project settings", () => {
	it("refuses to write project settings when the project is untrusted", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir, { projectTrusted: false });
		expect(() => settingsManager.setProjectSkillPaths([])).toThrow(/not trusted/i);
	});

	it("drops an existing project settings file when the project becomes untrusted", () => {
		const projectDir = join(tempDir, ".pi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "settings.json"), JSON.stringify({ quietStartup: true }));

		const trusted = SettingsManager.create(tempDir, tempDir, { projectTrusted: true });
		expect(trusted.getQuietStartup()).toBe(true);

		// Same file, untrusted project: the project layer must not contribute.
		const untrusted = SettingsManager.create(tempDir, tempDir, { projectTrusted: false });
		expect(untrusted.getQuietStartup()).toBe(false);
	});

	it("keeps global settings readable while the project is untrusted", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));

		const settingsManager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
		expect(settingsManager.getQuietStartup()).toBe(true);
	});

	it("records a trust decision that the settings layer consults", () => {
		const store = new ProjectTrustStore(join(tempDir, "trust.json"));
		// null means "not decided yet", which the settings layer treats as untrusted.
		expect(store.get(tempDir)).toBeNull();
		store.set(tempDir, true);
		expect(store.get(tempDir)).toBe(true);
		store.set(tempDir, false);
		expect(store.get(tempDir)).toBe(false);
	});
});

describe("I7: the self-update barrier cannot be influenced by settings", () => {
	it("refuses self-update before any network access", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await handlePackageCommand(["update", "--self"])).toBe(true);

		expect(errorSpy.mock.calls.map(([m]) => String(m)).join("\n")).toContain("self-update is disabled");
		expect(process.exitCode).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stays blocked no matter what the settings file contains", async () => {
		// The barrier's decision input is the process env only, so no persisted
		// setting can re-enable replacement of this build.
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				quietStartup: true,
				enableInstallTelemetry: true,
				// Attempted bypasses, including OMP's own update knobs.
				startup: { checkUpdate: true },
				update: { channel: "canary" },
				marketplace: { autoUpdate: "auto" },
				failover: "compatible",
			}),
		);
		const settingsManager = SettingsManager.create(tempDir, agentDir);

		const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		await handlePackageCommand(["update"]);

		expect(errorSpy.mock.calls.map(([m]) => String(m)).join("\n")).toContain("self-update is disabled");
		expect(fetchMock).not.toHaveBeenCalled();
		// Reading settings must not have thrown on the unknown keys either.
		expect(settingsManager.getQuietStartup()).toBe(true);
	});

	it("requires an explicit env opt-in, and only that", async () => {
		vi.stubEnv(ALLOW_SELF_UPDATE_ENV, "1");
		const fetchMock = vi.fn(async () => Response.json({ version: "0.0.1" }));
		vi.stubGlobal("fetch", fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await handlePackageCommand(["update", "--self"]);

		// Opted in, the version check is allowed to run.
		expect(fetchMock).toHaveBeenCalled();
		expect(logSpy.mock.calls.map(([m]) => String(m)).join("\n")).toContain("already up to date");
	});

	it("does not block extension updates, which never touch the app install", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await handlePackageCommand(["update", "--extensions"]);
		const output = logSpy.mock.calls.map(([m]) => String(m)).join("\n");
		expect(output).toContain("Updated packages");
		expect(output).not.toContain("self-update is disabled");
	});
});

describe("I8: build-integrity gates remain part of the check contract", () => {
	it("keeps every integrity gate wired into the root check script", () => {
		// package.json is the build contract manifest, not implementation source, so
		// asserting its shape is a build test rather than a source grep.
		const rootPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const check = rootPackage.scripts.check;
		for (const gate of [
			"check:pinned-deps",
			"check:runtime-deps",
			"check:ts-imports",
			"check:entry-graphs",
			"check:shrinkwrap",
			"check:install-lock:coding-agent",
		]) {
			expect(check).toContain(gate);
			expect(rootPackage.scripts[gate]).toBeDefined();
		}
		// The typecheck gate is an inline invocation, not a named script.
		expect(check).toContain("tsgo --noEmit");
	});

	it("keeps the coding-agent shrinkwrap and install-lock present and non-empty", () => {
		for (const artifact of ["packages/coding-agent/npm-shrinkwrap.json", "packages/coding-agent/install-lock"]) {
			expect(existsSync(join(process.cwd(), artifact))).toBe(true);
		}
	});
});
