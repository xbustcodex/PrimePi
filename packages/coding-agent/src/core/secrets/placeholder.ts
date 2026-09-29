/**
 * Outbound secret redaction: what leaves the machine.
 *
 * ## The problem
 *
 * A user configures an API key and then asks the model to read a config file
 * containing it. The request goes to a provider, and the key is in it. Settings
 * masking does not help: that hides a value in the *panel*, and this is about
 * the request body.
 *
 * ## Why a placeholder rather than a redaction marker
 *
 * Replacing a secret with `[REDACTED]` breaks the turn. The model is told a
 * value is configured and then cannot use it, so it invents one, or reports a
 * failure the user has to diagnose. A placeholder preserves the structure: the
 * same secret is replaced by the same marker everywhere in the request, so the
 * model can still reason about *which* key goes *where*, and the key is restored
 * after the provider responds.
 *
 * ## Why the marker is keyed
 *
 * An unkeyed marker is a dictionary attack. Given `SECRET_abc123`, an attacker
 * with a candidate list recomputes the hash for each candidate and finds the
 * one that matches — which is every credential in the environment. Keying the
 * digest with a per-install secret means the marker is stable within an install
 * and useless outside it.
 *
 * The key is **per-process random when none is supplied**, so a marker cannot be
 * reversed by anyone who obtains a session transcript. That forfeits
 * cross-session token stability, which a persisted key would provide; the trade
 * is deliberate and is the safe default.
 *
 * ## Why the hash is long
 *
 * 12 base-36 characters is roughly 62 bits. A short marker would let two
 * different secrets collide on the same placeholder, and a persisted marker would
 * then de-obfuscate to the wrong secret once the configured set or its ordering
 * changed. A collision here is a silent wrong-secret substitution, so the
 * length is sized to make it improbable rather than merely unlikely.
 *
 * ## Short matches are not obfuscated
 *
 * A regex match shorter than {@link MIN_OBFUSCATE_SECRET_LEN} is a small word or
 * fragment, and replacing it with a placeholder would redact ordinary prose
 * while leaking nothing. Those are left for the caller to handle, if at all.
 */

import { createHmac, randomBytes } from "node:crypto";

/** Alphabet for the hash base: letters and digits only, so it is unambiguous in a transcript. */
const HASH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Base length, sized for ~62 bits of entropy.
 *
 * See the module comment: a collision maps one secret's placeholder onto another
 * and silently substitutes the wrong value.
 */
const HASH_LEN = 12;

/** Matches shorter than this are not obfuscated; they are fragments, not secrets. */
export const MIN_OBFUSCATE_SECRET_LEN = 8;

const MAX_FRIENDLY_NAME_LEN = 32;

/** Per-process fallback key. Random, never shipped in source. */
let ephemeralKey: string | undefined;

/**
 * A random per-process key.
 *
 * Generated rather than derived, so a transcript obtained from a crashed or
 * shared machine cannot be replayed against a guessable key.
 */
export function defaultPlaceholderKey(): string {
	ephemeralKey ??= randomBytes(32).toString("base64url");
	return ephemeralKey;
}

/**
 * The stable base a secret's placeholders are built from.
 *
 * Keyed, and derived from the secret's own bytes, so the same secret yields the
 * same base within an install and two different secrets almost never share one.
 */
export function buildHashBase(key: string, value: string): string {
	const digest = createHmac("sha256", key).update(value).digest();
	// The first eight digest bytes are 64 bits, rendered base-36; the loop emits
	// HASH_LEN characters, which is fewer than the 13 the value could produce, so
	// the marker length is fixed and the mapping is deterministic.
	let remaining = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`);
	const radix = BigInt(HASH_CHARS.length);
	let tag = "";
	for (let index = 0; index < HASH_LEN; index++) {
		tag += HASH_CHARS[Number(remaining % radix)];
		remaining /= radix;
	}
	return tag;
}

/** Normalises a friendly name into the model-visible placeholder prefix. */
export function sanitizeSecretFriendlyName(name: string): string | undefined {
	const sanitized = name
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, MAX_FRIENDLY_NAME_LEN);
	return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Normalises a secret for comparison.
 *
 * Never truncates, unlike the friendly-name form, because a comparison must not
 * be satisfied by a prefix: a label that matches the first few characters of a
 * secret leaks the rest of it by implication.
 */
export function sanitizeForCollisionCheck(value: string): string {
	return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Whether a label would itself leak a secret.
 *
 * A label leaks either by containing the whole normalised secret, or by being
 * the secret's visible prefix once the display cap is applied. A short generic
 * label like `TOKEN` is not a leak.
 */
export function sanitizedLabelCollidesWithSecret(sanitizedLabel: string, sanitizedSecret: string): boolean {
	if (sanitizedLabel.length === 0 || sanitizedSecret.length === 0) return false;
	if (sanitizedSecret.includes(sanitizedLabel)) return true;
	// The display cap: a label that survives truncation to 32 characters and is a
	// prefix of the secret reveals everything after the cap.
	if (sanitizedLabel.length >= MAX_FRIENDLY_NAME_LEN && sanitizedSecret.startsWith(sanitizedLabel)) return true;
	return false;
}

/** A configured secret, with the name the user gave it. */
export interface SecretEntry {
	readonly value: string;
	/** Optional label; shown in the placeholder so the model can identify the key. */
	readonly name?: string;
}

/** The placeholder standing in for one secret, and the secret it stands for. */
export interface PlaceholderMapping {
	/** The marker that appears in the request. */
	readonly placeholder: string;
	/** The secret to put back in the response. */
	readonly value: string;
}

/**
 * The placeholders for a set of secrets, derived from one key.
 *
 * Built once per request and discarded after, so a placeholder never outlives
 * the turn it belongs to.
 */
export class SecretObfuscator {
	readonly #key: string;
	readonly #entries: readonly SecretEntry[];
	readonly #byPlaceholder: Map<string, string>;

	constructor(entries: readonly SecretEntry[], key: string = defaultPlaceholderKey()) {
		this.#key = key;
		// Longest first, so a secret that is a prefix of another is replaced whole
		// rather than leaving a fragment that no longer matches anything.
		this.#entries = [...entries]
			.filter((entry) => entry.value.length >= MIN_OBFUSCATE_SECRET_LEN)
			.sort((left, right) => right.value.length - left.value.length);
		this.#byPlaceholder = new Map();
		for (const entry of this.#entries) {
			this.#byPlaceholder.set(this.#placeholderFor(entry), entry.value);
		}
	}

	/** The number of secrets that will actually be replaced. */
	get size(): number {
		return this.#entries.length;
	}

	#placeholderFor(entry: SecretEntry): string {
		const base = buildHashBase(this.#key, entry.value);
		const label = entry.name ? sanitizeSecretFriendlyName(entry.name) : undefined;
		// A label that would itself leak the secret is dropped rather than shown.
		const safeLabel =
			label && !sanitizedLabelCollidesWithSecret(label, sanitizeForCollisionCheck(entry.value)) ? label : undefined;
		return safeLabel ? `SECRET_${safeLabel}_${base}` : `SECRET_${base}`;
	}

	/**
	 * Replaces every configured secret in a string with its placeholder.
	 *
	 * A blank result means nothing was replaced, which is the common case and must
	 * not allocate a copy of the input for nothing.
	 */
	obfuscate(text: string): string {
		if (text.length === 0) return text;
		let result = text;
		for (const entry of this.#entries) {
			if (!result.includes(entry.value)) continue;
			result = result.split(entry.value).join(this.#placeholderFor(entry));
		}
		return result;
	}

	/** The secrets that will be replaced, for a caller deciding whether to run the transform. */
	values(): readonly string[] {
		return this.#entries.map((entry) => entry.value);
	}
}
