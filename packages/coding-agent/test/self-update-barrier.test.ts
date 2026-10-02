import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import {
	ALLOW_SELF_UPDATE_ENV,
	isSelfUpdateAllowed,
	selfUpdateBlockedMessage,
} from "../src/utils/self-update-barrier.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("self-update barrier", () => {
	describe("isSelfUpdateAllowed", () => {
		it("is disabled when the opt-in env var is unset", () => {
			expect(isSelfUpdateAllowed({})).toBe(false);
		});

		it("is disabled for empty or non-truthy values", () => {
			for (const value of ["", " ", "0", "false", "no", "off", "maybe", "2"]) {
				expect(isSelfUpdateAllowed({ [ALLOW_SELF_UPDATE_ENV]: value })).toBe(false);
			}
		});

		it("is enabled only for explicit opt-in values, case- and space-insensitive", () => {
			for (const value of ["1", "true", "TRUE", " yes ", "on", "On"]) {
				expect(isSelfUpdateAllowed({ [ALLOW_SELF_UPDATE_ENV]: value })).toBe(true);
			}
		});
	});

	describe("blocked message", () => {
		it("names the app, the manual rebuild path, and the opt-in escape hatch", () => {
			const message = selfUpdateBlockedMessage("pi");
			expect(message).toContain("pi self-update is disabled");
			expect(message).toContain("npm run build");
			expect(message).toContain(`${ALLOW_SELF_UPDATE_ENV}=1`);
		});
	});

	describe("pi update", () => {
		let agentDir: string;
		let originalCwd: string;
		let originalAgentDir: string | undefined;
		let originalExitCode: typeof process.exitCode;

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "pi-self-update-barrier-"));
			mkdirSync(agentDir, { recursive: true });
			originalCwd = process.cwd();
			originalAgentDir = process.env[ENV_AGENT_DIR];
			originalExitCode = process.exitCode;
			process.exitCode = undefined;
			process.env[ENV_AGENT_DIR] = agentDir;
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			vi.restoreAllMocks();
			process.chdir(originalCwd);
			process.exitCode = originalExitCode;
			if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = originalAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		});

		it("refuses to self-update by default, without touching the network", async () => {
			const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
			vi.stubGlobal("fetch", fetchMock);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});

			expect(await handlePackageCommand(["update", "--self"])).toBe(true);

			const errors = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(errors).toContain("pi self-update is disabled");
			expect(errors).toContain("npm run build");
			expect(process.exitCode).toBe(1);
			// The barrier must short-circuit before any version check or install.
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("refuses the bare `pi update` default target too", async () => {
			const fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
			vi.stubGlobal("fetch", fetchMock);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});

			expect(await handlePackageCommand(["update"])).toBe(true);

			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"pi self-update is disabled",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("does not block extension updates, which never touch the app install", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			// No extensions configured: the update is a no-op, but it must not be
			// rejected by the self-update barrier.
			await handlePackageCommand(["update", "--extensions"]);

			const errors = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(errors).not.toContain("self-update is disabled");
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Updated packages");
		});

		it("reaches the upstream plan when the operator opts in explicitly", async () => {
			// The version check returns early under PI_OFFLINE, which vitest.config.ts
			// sets for the whole suite. Without this opt-out the fetch never happens and the
			// assertion below fails on a policy the suite itself declares - it only passed
			// when the file was invoked from the repo root, where the package config is
			// not applied and PI_OFFLINE is left unset. `fetch` stays a local stub, so
			// nothing leaves the machine.
			allowNetwork();
			vi.stubEnv(ALLOW_SELF_UPDATE_ENV, "1");
			const fetchMock = vi.fn(async () => Response.json({ version: "0.0.0" }));
			vi.stubGlobal("fetch", fetchMock);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			await handlePackageCommand(["update", "--self"]);

			const errors = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(errors).not.toContain("self-update is disabled");
			// Opted in, the version check runs and reports no upgrade available.
			expect(fetchMock).toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("pi is already up to date");
		});
	});
});
