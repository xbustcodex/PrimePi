import { describe, expect, it } from "vitest";
import {
	credentialAffinity,
	normalizePrivateKey,
	redactPrivateMetadata,
	securityAvailability,
	securityDisabledMessage,
} from "../src/core/security/redaction.ts";

/**
 * Security-scan redaction.
 *
 * Two properties carry this module. **Keys are matched normalised**, so a
 * denylist cannot be defeated by serialisation style — the failure there is
 * silent. And **a failure to read the setting resolves to off**, because a
 * namespace opened by a read error is the one direction of failure that matters.
 */

const scan = {
	id: "scan-1",
	status: "complete",
	producer: { name: "semgrep", version: "1.0" },
	findings: [{ rule: "hardcoded-secret", severity: "high", account: "acct-123", accessToken: "tok-abc" }],
	account: { id: "acct-123", email: "user@example.test" },
};

describe("private fields are stripped recursively", () => {
	it("removes them at every depth", () => {
		const redacted = redactPrivateMetadata(scan) as Record<string, unknown>;
		expect(JSON.stringify(redacted)).not.toContain("acct-123");
		expect(JSON.stringify(redacted)).not.toContain("tok-abc");
		expect(JSON.stringify(redacted)).not.toContain("user@example.test");
	});

	it("keeps everything that is not private", () => {
		// A key like `user` is not a secret, and redacting it would make a finding
		// unreadable - which is why the list is explicit rather than heuristic.
		const redacted = redactPrivateMetadata(scan) as Record<string, unknown>;
		expect(redacted.id).toBe("scan-1");
		expect(redacted.producer).toEqual({ name: "semgrep", version: "1.0" });
		const findings = redacted.findings as Record<string, unknown>[];
		expect(findings[0]!.rule).toBe("hardcoded-secret");
		expect(findings[0]!.severity).toBe("high");
	});

	it("leaves primitives and arrays alone in shape", () => {
		expect(redactPrivateMetadata("plain")).toBe("plain");
		expect(redactPrivateMetadata(42)).toBe(42);
		expect(redactPrivateMetadata(null)).toBeNull();
		expect(redactPrivateMetadata([{ token: "x", keep: 1 }])).toEqual([{ keep: 1 }]);
	});
});

describe("keys are matched normalised, not literally", () => {
	it("strips case and separators", () => {
		expect(normalizePrivateKey("access_token")).toBe("accesstoken");
		expect(normalizePrivateKey("accessToken")).toBe("accesstoken");
		expect(normalizePrivateKey("ACCESS-TOKEN")).toBe("accesstoken");
	});

	it("catches a camelCase spelling a literal denylist would miss", () => {
		// The failure otherwise is silent: the value is emitted, the transcript keeps
		// it, and nothing reports that redaction ran.
		expect(redactPrivateMetadata({ accessToken: "x" })).toEqual({});
		expect(redactPrivateMetadata({ api_key: "x" })).toEqual({});
		expect(redactPrivateMetadata({ "API-KEY": "x" })).toEqual({});
	});

	it("catches a private key nested under a public one", () => {
		expect(redactPrivateMetadata({ meta: { session_id: "s1" } })).toEqual({ meta: {} });
	});
});

describe("a credential is referenced, not disclosed", () => {
	it("is stable for the same account", () => {
		// A scan must be able to say which account it authenticated as without
		// disclosing the account.
		const account = { id: "acct-1", provider: "x" };
		expect(credentialAffinity(account)).toBe(credentialAffinity({ provider: "x", id: "acct-1" }));
	});

	it("ignores key order", () => {
		expect(credentialAffinity({ a: 1, b: 2 })).toBe(credentialAffinity({ b: 2, a: 1 }));
	});

	it("differs for a different account", () => {
		expect(credentialAffinity({ id: "a" })).not.toBe(credentialAffinity({ id: "b" }));
	});

	it("carries no trace of the account it describes", () => {
		const affinity = credentialAffinity({ id: "acct-secret", email: "user@example.test" });
		expect(affinity).not.toContain("acct-secret");
		expect(affinity).not.toContain("user@example.test");
		expect(affinity).toContain("sha256:");
	});
});

describe("a failure to read the setting keeps the namespace closed", () => {
	it("is off when settings were never initialised", () => {
		const availability = securityAvailability({ settingsInitialized: false, readFailed: false, configured: true });
		expect(availability.enabled).toBe(false);
	});

	it("is off when the read threw", () => {
		// A namespace opened by a read error would expose security findings to a model
		// that was never granted them.
		const availability = securityAvailability({ settingsInitialized: true, readFailed: true, configured: true });
		expect(availability.enabled).toBe(false);
		if (availability.enabled) return;
		expect(availability.reason).toContain("narrows access");
	});

	it("is off when genuinely not configured", () => {
		expect(securityAvailability({ settingsInitialized: true, readFailed: false, configured: false }).enabled).toBe(
			false,
		);
	});

	it("is on only when initialised, readable and configured", () => {
		expect(securityAvailability({ settingsInitialized: true, readFailed: false, configured: true })).toEqual({
			enabled: true,
		});
	});

	it("tells the model how to enable it", () => {
		// A refusal that does not say what to do produces a retry loop.
		expect(securityDisabledMessage()).toContain("security.enabled");
	});
});
