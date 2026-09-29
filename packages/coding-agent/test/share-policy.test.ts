import { describe, expect, it } from "vitest";
import { decideShare, describeShare, type ShareSource, shareWarning } from "../src/core/share/policy.ts";

/**
 * Session sharing.
 *
 * The property that defines the design: **redaction is resolved against the
 * session's own project, not the invoking working directory.** A share run from
 * elsewhere still shares a session belonging to some project, and that project's
 * policy and secrets are the ones that apply.
 */

const source = (overrides: Partial<ShareSource> = {}): ShareSource => ({
	projectCwd: "/projects/app",
	redactSecrets: true,
	secretsEnabled: true,
	obfuscatorAvailable: true,
	...overrides,
});

describe("redaction is governed by the session's project", () => {
	it("redacts when both settings agree", () => {
		const decision = decideShare(source());
		expect(decision.action).toBe("share");
		if (decision.action !== "share") return;
		expect(decision.redacted).toBe(true);
	});

	it("ignores the invoking directory entirely", () => {
		// Sharing an old session from wherever you happen to be is the common case,
		// and the case where using the cwd's policy would be wrong.
		const fromElsewhere = decideShare(source(), { invokedFrom: "/somewhere/else" });
		const fromHome = decideShare(source(), { invokedFrom: "/home/user" });
		expect(fromElsewhere).toEqual(fromHome);
	});

	it("names the project whose secrets were used", () => {
		// So a user can tell which project the policy came from.
		const decision = decideShare(source({ projectCwd: "/projects/other" }));
		expect(decision.reason).toContain("/projects/other");
	});
});

describe("redaction is conjunctive", () => {
	it("does not redact when the share setting is off", () => {
		const decision = decideShare(source({ redactSecrets: false }));
		expect(decision.action).toBe("share");
		if (decision.action !== "share") return;
		expect(decision.redacted).toBe(false);
	});

	it("does not redact when the secrets setting is off", () => {
		const decision = decideShare(source({ secretsEnabled: false }));
		if (decision.action !== "share") return;
		expect(decision.redacted).toBe(false);
	});

	it("names both settings when neither applies", () => {
		// A share that went out unredacted should say which setting allowed it.
		const decision = decideShare(source({ redactSecrets: false, secretsEnabled: false }));
		expect(decision.reason).toContain("share.redactSecrets");
		expect(decision.reason).toContain("secrets.enabled");
	});
});

describe("refusing beats publishing", () => {
	it("refuses when redaction is required and cannot be applied", () => {
		// A published blob that looks redacted but was not is the worst outcome
		// available, and it is exactly what an absent-obfuscator path produces.
		const decision = decideShare(source({ obfuscatorAvailable: false }));
		expect(decision.action).toBe("refuse");
	});

	it("names the project whose obfuscator is missing", () => {
		const decision = decideShare(source({ obfuscatorAvailable: false, projectCwd: "/projects/app" }));
		expect(decision.reason).toContain("/projects/app");
	});

	it("shares when redaction is not required and no obfuscator exists", () => {
		// The missing obfuscator only matters when redaction was asked for.
		expect(decideShare(source({ redactSecrets: false, obfuscatorAvailable: false })).action).toBe("share");
	});
});

describe("a share that went out unredacted says so", () => {
	it("warns", () => {
		const decision = decideShare(source({ redactSecrets: false }));
		expect(shareWarning(decision)).toContain("WITHOUT secret redaction");
	});

	it("does not warn for a redacted share", () => {
		expect(shareWarning(decideShare(source()))).toBeUndefined();
	});

	it("does not warn for a refused share", () => {
		// A refusal is not something to warn about; it did not happen.
		expect(shareWarning(decideShare(source({ obfuscatorAvailable: false })))).toBeUndefined();
	});

	it("appears in the reported output", () => {
		const lines = describeShare(decideShare(source({ redactSecrets: false })), "https://share.test/abc");
		expect(lines[0]).toBe("Share URL: https://share.test/abc");
		expect(lines.join("\n")).toContain("Warning:");
	});

	it("leaves a redacted share as a single line", () => {
		expect(describeShare(decideShare(source()), "https://share.test/abc")).toEqual([
			"Share URL: https://share.test/abc",
		]);
	});
});
