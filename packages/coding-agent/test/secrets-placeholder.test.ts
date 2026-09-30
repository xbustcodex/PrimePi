import { describe, expect, it } from "vitest";
import {
	buildHashBase,
	defaultPlaceholderKey,
	MIN_OBFUSCATE_SECRET_LEN,
	SecretObfuscator,
	sanitizedLabelCollidesWithSecret,
	sanitizeForCollisionCheck,
	sanitizeSecretFriendlyName,
} from "../src/core/secrets/placeholder.ts";

/**
 * Outbound secret redaction.
 *
 * This is a security boundary, so the tests are adversarial: they check that a
 * secret cannot leak through a marker, a label, a short match, or a key choice.
 * A test that only proves "the secret is gone from the output" would pass for a
 * replacement that leaks it in the replacement.
 */

const KEY = "per-install-test-key";
const SECRET = "sk-ant-api03-Xy7Zq2K9mNb4Vc8Lp1Rt6Wj3Hd5Fg0";

describe("the marker cannot be reversed without the key", () => {
	it("differs for the same secret under a different key", () => {
		// A transcript obtained from one install must not de-obfuscate against
		// another, and must not be a dictionary attack against a candidate list.
		const here = buildHashBase(KEY, SECRET);
		const elsewhere = buildHashBase("a-different-key", SECRET);
		expect(here).not.toBe(elsewhere);
		expect(here).toHaveLength(12);
	});

	it("is stable for one key, so the same secret maps to the same marker", () => {
		// Two occurrences must become the same marker, or the model sees two
		// different values where there is one.
		expect(buildHashBase(KEY, SECRET)).toBe(buildHashBase(KEY, SECRET));
	});

	it("differs for different secrets under one key", () => {
		expect(buildHashBase(KEY, SECRET)).not.toBe(buildHashBase(KEY, `${SECRET}x`));
	});

	it("produces no separator characters that could be confused with structure", () => {
		const tag = buildHashBase(KEY, SECRET);
		expect(tag).toMatch(/^[A-Z0-9]+$/);
	});
});

describe("the per-process default key is random and not a constant", () => {
	it("is the same within a process, so one request is consistent", () => {
		expect(defaultPlaceholderKey()).toBe(defaultPlaceholderKey());
	});

	it("is long and random-shaped, never a shipped value", () => {
		const key = defaultPlaceholderKey();
		expect(key.length).toBeGreaterThanOrEqual(32);
		// 32 random bytes in base64url.
		expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe("replacement", () => {
	it("removes the secret entirely from the output", () => {
		const obfuscator = new SecretObfuscator([{ value: SECRET }], KEY);
		const text = `Here is my key: ${SECRET} — please use it.`;
		const result = obfuscator.obfuscate(text);
		expect(result).not.toContain(SECRET);
		expect(result).toContain("SECRET_");
		// The surrounding prose survives, so the model can still reason about it.
		expect(result).toContain("Here is my key:");
		expect(result).toContain("please use it.");
	});

	it("maps the same secret to the same marker everywhere in one text", () => {
		const obfuscator = new SecretObfuscator([{ value: SECRET }], KEY);
		const result = obfuscator.obfuscate(`${SECRET} and again ${SECRET}`);
		const markers = result.match(/SECRET_[A-Z0-9_]+/g) ?? [];
		expect(new Set(markers).size).toBe(1);
	});

	it("replaces a secret that is a prefix of a longer one, longest first", () => {
		const shorter = SECRET.slice(0, 20);
		const obfuscator = new SecretObfuscator([{ value: shorter }, { value: SECRET }], KEY);
		const result = obfuscator.obfuscate(`value: ${SECRET}`);
		// Replacing the short one first would leave a fragment that matches no
		// mapping, so the response could not be restored.
		expect(result).not.toContain(shorter);
		expect(result).not.toContain(SECRET);
	});

	it("leaves text with no secret untouched", () => {
		const obfuscator = new SecretObfuscator([{ value: SECRET }], KEY);
		const text = "nothing sensitive here";
		expect(obfuscator.obfuscate(text)).toBe(text);
	});

	it("handles an empty string without allocating", () => {
		expect(new SecretObfuscator([{ value: SECRET }], KEY).obfuscate("")).toBe("");
	});
});

describe("short matches are not obfuscated", () => {
	it("ignores a value below the minimum length", () => {
		// A short value is a fragment or an ordinary word, and a placeholder would
		// redact prose while leaking nothing.
		const obfuscator = new SecretObfuscator([{ value: "abc" }], KEY);
		expect(obfuscator.size).toBe(0);
		expect(obfuscator.obfuscate("abc appears here")).toBe("abc appears here");
	});

	it("uses a boundary that admits a real key shape", () => {
		expect(MIN_OBFUSCATE_SECRET_LEN).toBeLessThanOrEqual(SECRET.length);
	});
});

describe("a label must not leak the secret", () => {
	it("includes a safe label in the marker", () => {
		const obfuscator = new SecretObfuscator([{ value: SECRET, name: "anthropic key" }], KEY);
		const result = obfuscator.obfuscate(SECRET);
		expect(result).toContain("SECRET_ANTHROPICKEY_");
	});

	it("drops a label that is a prefix of the secret", () => {
		// A label that is the secret's own visible prefix reveals everything after
		// the display cap by implication.
		const prefix = sanitizeSecretFriendlyName(SECRET.slice(0, 40));
		expect(prefix).toBeDefined();
		expect(sanitizedLabelCollidesWithSecret(prefix!, sanitizeForCollisionCheck(SECRET))).toBe(true);

		const obfuscator = new SecretObfuscator([{ value: SECRET, name: SECRET.slice(0, 40) }], KEY);
		expect(obfuscator.obfuscate(SECRET)).not.toContain(sanitizeForCollisionCheck(SECRET));
	});

	it("drops a label that contains the whole secret", () => {
		expect(
			sanitizedLabelCollidesWithSecret("XY7ZQ2K9MNB4VC8LP1RT6WJ3HD5FG0", sanitizeForCollisionCheck(SECRET)),
		).toBe(true);
	});

	it("keeps a short generic label, which is not a leak", () => {
		// `TOKEN` is an intentional label and reveals nothing.
		expect(sanitizedLabelCollidesWithSecret("TOKEN", sanitizeForCollisionCheck(SECRET))).toBe(false);
	});

	it("sanitises a name into an alnum uppercase form", () => {
		expect(sanitizeSecretFriendlyName("my key!")).toBe("MYKEY");
		expect(sanitizeSecretFriendlyName("!!!")).toBeUndefined();
		expect(sanitizeSecretFriendlyName("x".repeat(60))).toHaveLength(32);
	});
});

describe("collision checking never satisfies on a prefix", () => {
	it("never satisfies on a partial match alone", () => {
		const sanitized = sanitizeForCollisionCheck("sk-ant-03-abc");
		expect(sanitized).toBe("SKANT03ABC");
		// A label contained anywhere in the secret leaks, whether it is a prefix,
		// a suffix or the whole thing.
		expect(sanitizedLabelCollidesWithSecret("SKANT", sanitized)).toBe(true);
		expect(sanitizedLabelCollidesWithSecret("03ABC", sanitized)).toBe(true);
		expect(sanitizedLabelCollidesWithSecret(sanitized, sanitized)).toBe(true);
		// And a label sharing no substring does not.
		expect(sanitizedLabelCollidesWithSecret("GITHUB", sanitized)).toBe(false);
	});
});
