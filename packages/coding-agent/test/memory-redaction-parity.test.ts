import { describe, expect, it } from "vitest";
import { redactMemorySecrets } from "../src/core/memory/redact.ts";

/**
 * The reference's own redaction expectations, run against the port.
 *
 * Read from `oh-my-pi/packages/coding-agent/test/memory-redaction.test.ts` at
 * eabd6b99c6. These are not new cases invented here: each one is an assertion
 * the reference already makes, so a divergence here is a divergence from
 * behaviour OMP has already proven.
 */

const NPM_TOKEN = `npm_${"A".repeat(30)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;

describe("ported redaction matches the reference's expectations", () => {
	it("redacts fixed-prefix provider tokens", () => {
		expect(redactMemorySecrets(`token is ${NPM_TOKEN} ok`)).toBe("token is [REDACTED] ok");
		expect(redactMemorySecrets(`id ${AWS_KEY}`)).toBe("id [REDACTED]");
		expect(redactMemorySecrets("xoxb-1234567890-abcdef")).toBe("[REDACTED]");
		expect(redactMemorySecrets("secret_aB3dEfGh1JkLmN0pQ")).toBe("[REDACTED]");
	});

	it("redacts a JWT but leaves a version number alone", () => {
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(24)}.${"b".repeat(20)}`;
		expect(redactMemorySecrets(`bearer ${jwt} sent`)).toBe("bearer [REDACTED] sent");
		// The two-part rule: a JWT needs three long segments. A semver has three
		// short ones, and redacting every dotted string would destroy build output,
		// import paths and version numbers.
		expect(redactMemorySecrets("version 1.2.3 released")).toBe("version 1.2.3 released");
	});

	it("leaves ordinary identifiers alone", () => {
		for (const identifier of [
			"passwordAuthenticationMiddleware",
			"tokenizationStrategy",
			"keyboardInterruptHandler",
			"token_bucket_rate_limiter",
			"secret_manager_client",
			"password_authentication",
			"token_authorization",
			"key_configuration",
		]) {
			expect(redactMemorySecrets(`calls ${identifier} twice`), identifier).toBe(`calls ${identifier} twice`);
		}
	});

	it("redacts a letters-only credential suffix", () => {
		expect(redactMemorySecrets("use password-supersecretvalue here")).toBe("use [REDACTED] here");
		expect(redactMemorySecrets("API token-abcdefghijklmnop leaked")).toBe("API [REDACTED] leaked");
	});

	it("scans a large unbroken run without rescanning its tail", () => {
		// 220 KB of one unbroken run. The earlier lookahead form took ~25s on this
		// input; a single pass must stay in milliseconds or retention stalls a session.
		const input = "token_aaaa-".repeat(20_000);
		const started = Date.now();
		expect(redactMemorySecrets(input)).toBe(input);
		// Generous, but a quadratic implementation cannot meet it at any size.
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
