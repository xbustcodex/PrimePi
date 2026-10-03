import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveSessionDirectory } from "../src/experimental/server.ts";

afterEach(() => vi.unstubAllEnvs());

describe("experimental server session directory", () => {
	test("uses the experimental directory under the configured agent directory by default", () => {
		// `resolve`, not the literal: `resolveSessionDirectory` runs the agent directory
		// through `resolvePath`, so a "/tmp/..." prefix canonicalises to "C:\tmp\..." on
		// Windows and the assertion could only ever hold on POSIX. Same reasoning as
		// `auto-resume-wiring.test.ts` for `process.cwd()`.
		const agentDir = resolve("/tmp/pi-agent-config");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		expect(resolveSessionDirectory()).toBe(resolve(agentDir, "experimental", "sessions"));
	});

	test("resolves an explicit relative directory from the current working directory", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent-config");

		expect(resolveSessionDirectory("relative/sessions")).toBe(resolve("relative/sessions"));
	});

	test("expands a tilde in an explicit directory", () => {
		expect(resolveSessionDirectory("~/custom-sessions")).toBe(resolve(homedir(), "custom-sessions"));
	});
});
