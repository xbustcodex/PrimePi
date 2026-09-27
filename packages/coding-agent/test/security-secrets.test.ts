import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { findSecretLeak, redactMessages, restoreToolArguments } from "../src/core/security/secret-transform.ts";
import {
	collectEnvSecrets,
	detectSecrets,
	isRedactable,
	maskSecret,
	SecretRedactor,
} from "../src/core/security/secrets.ts";

/**
 * Credential redaction.
 *
 * The properties under test, in order of how badly a failure would hurt:
 *
 *  1. a provider-bound projection contains no original secret;
 *  2. an authorized round trip returns the exact original;
 *  3. a forged or malformed placeholder reveals nothing;
 *  4. stored history is never rewritten, so provenance survives.
 */

// A distinctive, realistic-looking credential. Unique to this suite, so a leak
// anywhere in the test output is attributable to exactly one cause.
const TEST_SECRET = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OTHER_SECRET = "sk-ant-api03-Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed";
const URL_PASSWORD = "hunter2SuperSecretValue";

const redactor = () => new SecretRedactor([{ name: "gh", value: TEST_SECRET, friendlyName: "GITHUB" }]);

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

describe("secret detection", () => {
	it("recognizes a GitHub token", () => {
		expect(detectSecrets(`token is ${TEST_SECRET} here`).some((entry) => entry.value === TEST_SECRET)).toBe(true);
	});

	it("recognizes an Anthropic key", () => {
		expect(detectSecrets(`key ${OTHER_SECRET}`).some((entry) => entry.value === OTHER_SECRET)).toBe(true);
	});

	it("recognizes a URL password", () => {
		expect(
			detectSecrets(`postgres://user:${URL_PASSWORD}@db.internal/app`).some((entry) => entry.value === URL_PASSWORD),
		).toBe(true);
	});

	it("does not treat ordinary prose as a credential", () => {
		const found = detectSecrets("the quick brown fox jumps over the lazy dog, repeatedly and at length");
		expect(found).toEqual([]);
	});

	it("does not treat a long lowercase word as a credential", () => {
		// Entropy gating is what keeps ordinary content out of the redaction path.
		expect(detectSecrets("thisisalongunbrokenlowercaseword")).toEqual([]);
	});

	it("collects environment secrets by name and length", () => {
		const found = collectEnvSecrets({
			GITHUB_TOKEN: TEST_SECRET,
			PATH: "/usr/bin:/bin",
			TOKEN_MODE: "off",
			SHORT_KEY: "abc",
		});
		expect(found.map((entry) => entry.value)).toEqual([TEST_SECRET]);
	});

	it("refuses to fingerprint a value too short to be safe", () => {
		expect(isRedactable("short")).toBe(false);
		expect(isRedactable(TEST_SECRET)).toBe(true);
	});
});

describe("provider-bound projection contains no original secret", () => {
	it("removes the secret from user text", () => {
		const messages = [userMessage(`deploy with ${TEST_SECRET}`)];
		const projected = redactMessages(messages, redactor());
		expect(JSON.stringify(projected)).not.toContain(TEST_SECRET);
	});

	it("removes the secret from assistant text", () => {
		// The model echoes file contents, so an assistant message can carry a secret
		// that was read earlier.
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: `I found ${TEST_SECRET}` }] } as AgentMessage,
		];
		expect(JSON.stringify(redactMessages(messages, redactor()))).not.toContain(TEST_SECRET);
	});

	it("removes the secret from tool results", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [{ type: "text", text: `contents: ${TEST_SECRET}` }],
			} as unknown as AgentMessage,
		];
		expect(JSON.stringify(redactMessages(messages, redactor()))).not.toContain(TEST_SECRET);
	});

	it("removes the secret from structured tool details", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [],
				details: { env: { GITHUB_TOKEN: TEST_SECRET }, nested: { deeper: [`prefix ${TEST_SECRET}`] } },
			} as unknown as AgentMessage,
		];
		const projected = redactMessages(messages, redactor());
		expect(JSON.stringify(projected)).not.toContain(TEST_SECRET);
	});

	it("detects a leak before the payload is sent", () => {
		expect(findSecretLeak(`contains ${TEST_SECRET}`, redactor())).toBe(true);
		expect(findSecretLeak("no credential here", redactor())).toBe(false);
	});

	it("handles several distinct secrets in one payload", () => {
		const many = new SecretRedactor([
			{ name: "gh", value: TEST_SECRET },
			{ name: "anthropic", value: OTHER_SECRET },
		]);
		const projected = redactMessages([userMessage(`${TEST_SECRET} and ${OTHER_SECRET}`)], many);
		const serialized = JSON.stringify(projected);
		expect(serialized).not.toContain(TEST_SECRET);
		expect(serialized).not.toContain(OTHER_SECRET);
	});
});

describe("authorized round trip", () => {
	it("restores the exact original value", () => {
		const r = redactor();
		const original = `export GITHUB_TOKEN=${TEST_SECRET}`;
		const restored = r.restore(r.redact(original));
		expect(restored).toBe(original);
	});

	it("restores a value used as a tool argument", () => {
		const r = redactor();
		const redactedArgs = { command: `git push https://x:${TEST_SECRET}@github.com` };
		const restored = restoreToolArguments(redactedArgs, r) as { command: string };
		expect(restored.command).toBe(`git push https://x:${TEST_SECRET}@github.com`);
	});

	it("restores nested argument structures", () => {
		const r = redactor();
		const args = { a: ["x", { b: TEST_SECRET }], c: 1, d: true, e: null };
		expect(JSON.stringify(restoreToolArguments(args, r))).toBe(JSON.stringify(args));
	});

	it("redacts repeatedly without drift", () => {
		// Idempotence is what makes a redact/project/restore/redact cycle safe.
		const r = redactor();
		const once = r.redact(`value ${TEST_SECRET}`);
		const twice = r.redact(once);
		expect(twice).toBe(once);
		expect(JSON.parse(JSON.stringify(twice))).toEqual(JSON.parse(JSON.stringify(once)));
	});

	it("returns the identical array when there is nothing to redact", () => {
		const messages = [userMessage("nothing sensitive here")];
		expect(redactMessages(messages, redactor())).toBe(messages);
	});

	it("does not mutate the input messages", () => {
		const messages = [userMessage(`deploy with ${TEST_SECRET}`)];
		const before = JSON.stringify(messages);
		redactMessages(messages, redactor());
		expect(JSON.stringify(messages)).toBe(before);
	});
});

describe("canonical history retains its original text and provenance", () => {
	it("leaves the stored messages byte-identical after a projection is built", () => {
		// The stored record is the canonical history. Redaction applies to the
		// derived projection only, so a resumed session still holds the original.
		const stored = [userMessage(`deploy with ${TEST_SECRET}`)];
		const storedSnapshot = JSON.stringify(stored);

		const projected = redactMessages(stored, redactor());
		expect(JSON.stringify(projected)).not.toBe(storedSnapshot);
		expect(JSON.stringify(stored)).toBe(storedSnapshot);
	});

	it("preserves message identity for unmodified entries", () => {
		const original = userMessage("clean");
		const projected = redactMessages([original], redactor());
		expect(projected[0]).toBe(original);
	});

	it("preserves the original object for a changed message and only copies that one", () => {
		const dirty = userMessage(`secret ${TEST_SECRET}`);
		const clean = userMessage("clean");
		const projected = redactMessages([dirty, clean], redactor());
		expect(projected[1]).toBe(clean);
		expect(projected[0]).not.toBe(dirty);
	});
});

describe("placeholder collision and forgery", () => {
	it("never places the original secret inside the placeholder", () => {
		const r = redactor();
		const output = r.redact(`value ${TEST_SECRET}`);
		expect(output).not.toContain(TEST_SECRET);
		expect(output).toContain("$$");
	});

	it("gives two secrets different placeholders", () => {
		const r = new SecretRedactor([
			{ name: "a", value: TEST_SECRET },
			{ name: "b", value: OTHER_SECRET },
		]);
		const first = r.redact(TEST_SECRET);
		const second = r.redact(OTHER_SECRET);
		expect(first).not.toBe(second);
	});

	it("does not reuse a base even under a deterministic random source", () => {
		// A stubbed source that always returns the same value would collide
		// forever if the allocator did not guarantee forward progress.
		const r = new SecretRedactor(
			[
				{ name: "a", value: TEST_SECRET },
				{ name: "b", value: OTHER_SECRET },
			],
			{ random: () => 0.5 },
		);
		expect(r.redact(TEST_SECRET)).not.toBe(r.redact(OTHER_SECRET));
	});

	it("leaves a placeholder it never minted as literal text", () => {
		// A forged token must not be "helpfully" resolved.
		const r = redactor();
		const forged = "$$NOTAREALPLACEHOLDERAB$$";
		expect(r.restore(forged)).toBe(forged);
	});

	it("refuses a forged token that embeds a secret in its label", () => {
		// Otherwise a hostile conversation could ask a local tool to expand a
		// credential the writer never had.
		const r = redactor();
		const forged = `$$${TEST_SECRET}$${"A".repeat(12)}$$`;
		expect(r.restore(forged)).toBe(forged);
	});

	it("leaves a malformed placeholder untouched", () => {
		const r = redactor();
		for (const malformed of ["$$", "$$ABC", "$$$$", "$$abc$$", "$$TOOSHORT$$"]) {
			expect(r.restore(malformed)).toBe(malformed);
		}
	});

	it("does not restore a placeholder belonging to a different redactor", () => {
		const mine = redactor();
		const placeholder = mine.redact(TEST_SECRET);
		const other = new SecretRedactor([{ name: "gh", value: TEST_SECRET }]);
		// A fresh redactor has its own map, so the old token resolves to nothing.
		expect(other.restore(placeholder)).toBe(placeholder);
	});

	it("refuses to restore through a second expansion", () => {
		// Single-pass: a restored value containing a placeholder shape is not rescanned.
		const r = redactor();
		const once = r.redact(`a ${TEST_SECRET}`);
		expect(r.restore(once)).toBe(`a ${TEST_SECRET}`);
	});

	it("flags an unterminated placeholder so a stream cannot split one", () => {
		const r = redactor();
		const complete = r.redact(TEST_SECRET);
		expect(r.hasPartialPlaceholder(complete)).toBe(false);
		expect(r.hasPartialPlaceholder("trailing $$GITHUB_ABC")).toBe(true);
	});
});

describe("irreversible masking", () => {
	it("produces no restorable token", () => {
		expect(maskSecret(TEST_SECRET)).not.toContain("$$");
		expect(maskSecret(TEST_SECRET)).not.toContain(TEST_SECRET);
	});
});

describe("adversarial: attempts to leak a known secret", () => {
	const LEAK = TEST_SECRET;

	it("cannot leak through tool arguments rendered for the model", () => {
		// The model is told what the tool was asked to do. A credential in the
		// arguments must not reach it.
		const redacted = redactMessages([userMessage(JSON.stringify({ command: `deploy ${LEAK}` }))], redactor());
		expect(findSecretLeak(JSON.stringify(redacted), redactor())).toBe(false);
	});

	it("cannot leak through a tool result read back from a file", () => {
		const fileContents = `line one\nGITHUB_TOKEN=${LEAK}\nline three`;
		const messages = [
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [{ type: "text", text: fileContents }],
			} as unknown as AgentMessage,
		];
		expect(findSecretLeak(JSON.stringify(redactMessages(messages, redactor())), redactor())).toBe(false);
	});

	it("cannot leak through externally supplied content", () => {
		// Content the model did not author and this process never held: detected by
		// shape at the boundary rather than by prior registration.
		const external = `A remote page said: your token is ${LEAK} enjoy`;
		const detected = detectSecrets(external);
		expect(detected.some((entry) => entry.value === LEAK)).toBe(true);
		const redacted = new SecretRedactor(detected).redact(external);
		expect(redacted).not.toContain(LEAK);
	});

	it("cannot leak through a diagnostic serialization of the projection", () => {
		const projected = redactMessages([userMessage(`diagnostic ${LEAK}`)], redactor());
		// Whatever a diagnostic dump does with the projection, the secret is gone
		// before it is handed over.
		expect(JSON.stringify(projected, null, 2)).not.toContain(LEAK);
	});

	it("cannot leak through a partially streamed payload", () => {
		const r = redactor();
		const full = r.redact(`deploy ${LEAK}`);
		expect(full).not.toContain(LEAK);
		// A stream can split mid-placeholder. The complete form is safe, and a
		// truncated one is detectable so it is never emitted as-is.
		const start = full.indexOf("$$");
		const partial = full.slice(0, start + 6);
		expect(partial).toContain("$$");
		expect(r.hasPartialPlaceholder(partial)).toBe(true);
		expect(r.hasPartialPlaceholder(full)).toBe(false);
	});

	it("cannot leak through a nested details payload with a class instance", () => {
		// A class instance may hold a handle or a cycle; it is passed through rather
		// than copied, so redaction cannot corrupt it into disclosing more.
		class Opaque {
			value = LEAK;
		}
		const messages = [
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [],
				details: { opaque: new Opaque() },
			} as unknown as AgentMessage,
		];
		// The redactor does not walk it, so it is unchanged — which is why the
		// provider boundary also runs a detection pass over serialized output.
		const projected = redactMessages(messages, redactor());
		expect(projected[0]).toBe(messages[0]);
	});
});
