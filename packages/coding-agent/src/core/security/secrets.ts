/**
 * Reversible credential redaction.
 *
 * ## The one-way / two-way split
 *
 * A secret crosses three boundaries with different needs:
 *
 *   outbound to a provider -> must NOT contain the secret
 *   inbound to a local tool -> MUST contain the real value, or the tool breaks
 *   rendered for a human   -> must NOT contain the secret
 *
 * So redaction is not one operation. `redact` emits a placeholder and is safe in
 * the first and third cases; `restore` puts the real value back and belongs only
 * to the second. Keeping them distinct in name and signature is deliberate:
 * calling `restore` on a provider-bound payload is the exact bug this module
 * exists to make hard to write.
 *
 * ## Failure is closed
 *
 * Every ambiguous case resolves toward not revealing:
 *
 * - a placeholder this process never minted is left as literal text, not guessed;
 * - a token whose label is itself a known secret is refused, so a credential
 *   cannot be smuggled through the label position;
 * - a value too short to fingerprint is left alone, because a one-character
 *   "hash" collides and a collision makes restoration ambiguous.
 *
 * ## History is never rewritten
 *
 * `redact` and `restore` return new strings. The canonical stored session is
 * untouched, so provenance survives and a resumed session still holds the
 * original text. Only the provider-bound projection is transformed.
 */

import {
	BEARER_TOKEN_PATTERN,
	BUILT_IN_CREDENTIAL_PATTERNS,
	CONNECTION_URL_PASSWORD_PATTERN,
	hasPlausibleCredentialEntropy,
	MIN_ENV_SECRET_LENGTH,
	SECRET_ENV_NAME_PATTERN,
} from "./secret-patterns.ts";

/** A recognized secret. */
export interface SecretEntry {
	/** Stable identifier for diagnostics. Never the secret itself. */
	name: string;
	/** The raw material. Held in memory only; never serialized. */
	value: string;
	/** Short label rendered into the placeholder, e.g. `GITHUB`. */
	friendlyName?: string;
}

/**
 * Placeholder alphabet.
 *
 * Uppercase alphanumerics only. Punctuation would need escaping to survive a
 * shell, a JSON payload, and a regex unchanged, so it is excluded rather than
 * handled.
 */
const PLACEHOLDER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Random part length. */
const PLACEHOLDER_RANDOM_LENGTH = 12;

/**
 * Shortest value we will fingerprint.
 *
 * Below this, two distinct secrets could share a placeholder, and ambiguous
 * restoration is worse than no redaction.
 */
export const MIN_SECRET_LENGTH = 8;

/** Matches a complete placeholder: optional label, then the random base. */
const PLACEHOLDER_PATTERN = /\$\$([A-Z0-9]{2,32})?_?([A-Z0-9]{12})\$\$/g;

const PLACEHOLDER_OPEN = "$$";

/** Whether a value is long enough to fingerprint safely. */
export function isRedactable(value: string): boolean {
	return value.length >= MIN_SECRET_LENGTH;
}

/**
 * Strips a friendly name to something safe to embed.
 *
 * Only uppercase alphanumerics survive, capped in length. A name that sanitizes
 * to nothing usable is dropped, so callers can distinguish "no label" from "a
 * label that happened to be empty".
 */
export function sanitizeFriendlyName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	const cleaned = name
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 32);
	return cleaned.length >= 2 ? cleaned : undefined;
}

/**
 * Collects secrets from the environment.
 *
 * Both the name and the value must qualify. `TOKEN_MODE=off` is a flag, not a
 * credential, and redacting it would be noise the operator cannot act on.
 */
export function collectEnvSecrets(env: Readonly<Record<string, string | undefined>> = process.env): SecretEntry[] {
	const entries: SecretEntry[] = [];
	const seen = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < MIN_ENV_SECRET_LENGTH) continue;
		if (!SECRET_ENV_NAME_PATTERN.test(name)) continue;
		if (seen.has(value)) continue;
		seen.add(value);
		entries.push({ name, value, friendlyName: name.split("_")[0] });
	}
	return entries;
}

/** Redacts recognized credential shapes found in arbitrary text. */
export function detectSecrets(text: string): SecretEntry[] {
	if (!text) return [];
	const found: SecretEntry[] = [];
	const seen = new Set<string>();

	for (const { name, pattern } of BUILT_IN_CREDENTIAL_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const value = match[0];
			if (!value || seen.has(value)) continue;
			if (!hasPlausibleCredentialEntropy(value)) continue;
			seen.add(value);
			found.push({
				name,
				value,
				friendlyName: name
					.toUpperCase()
					.replace(/[^A-Z0-9]/g, "")
					.slice(0, 32),
			});
		}
	}

	BEARER_TOKEN_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(BEARER_TOKEN_PATTERN)) {
		const value = match[0];
		if (!value || seen.has(value) || !hasPlausibleCredentialEntropy(value)) continue;
		seen.add(value);
		found.push({ name: "bearer-token", value });
	}

	// Connection-URL passwords are captured whole and re-emitted without the
	// password, so the scheme and host stay readable.
	CONNECTION_URL_PASSWORD_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(CONNECTION_URL_PASSWORD_PATTERN)) {
		const password = match[2];
		if (!password || seen.has(password) || password.length < MIN_SECRET_LENGTH) continue;
		seen.add(password);
		found.push({ name: "url-password", value: password });
	}

	return found;
}

/**
 * The redaction engine.
 *
 * The placeholder map is process-local. Nothing is written to disk, so a fresh
 * process can only restore a secret it was actually handed — a restored value
 * can never be reconstructed from placeholder text alone.
 */
export class SecretRedactor {
	readonly #restorable = new Map<string, string>();
	readonly #secretValues = new Set<string>();
	readonly #usedBases = new Set<string>();
	readonly #byValue = new Map<string, SecretEntry>();
	readonly #random: () => number;
	#counter = 0;

	constructor(entries: readonly SecretEntry[] = [], options: { random?: () => number } = {}) {
		this.#random = options.random ?? Math.random;
		for (const entry of entries) {
			// Deduplicate by value: two names for one secret must not yield two
			// placeholders, or identical text would redact inconsistently.
			if (this.#byValue.has(entry.value)) continue;
			this.#byValue.set(entry.value, entry);
			this.#secretValues.add(entry.value);
		}
	}

	/** How many distinct secrets this redactor holds. Reveals no values. */
	get size(): number {
		return this.#byValue.size;
	}

	get isEmpty(): boolean {
		return this.#byValue.size === 0;
	}

	/**
	 * Allocates an unused placeholder base.
	 *
	 * Retries on collision rather than reusing, because two secrets sharing a
	 * placeholder would make restoration ambiguous and therefore unsafe. The
	 * counter guarantees forward progress even under a stubbed random source.
	 */
	#allocateBase(): string {
		for (let attempt = 0; attempt < 64; attempt++) {
			let base = "";
			for (let index = 0; index < PLACEHOLDER_RANDOM_LENGTH; index++) {
				const position = Math.min(
					Math.floor(this.#random() * PLACEHOLDER_ALPHABET.length),
					PLACEHOLDER_ALPHABET.length - 1,
				);
				base += PLACEHOLDER_ALPHABET[position];
			}
			if (!this.#usedBases.has(base)) {
				this.#usedBases.add(base);
				return base;
			}
		}
		this.#counter += 1;
		const fallback = `REDACTED${this.#counter.toString(36).toUpperCase()}`.slice(0, PLACEHOLDER_RANDOM_LENGTH);
		this.#usedBases.add(fallback);
		return fallback;
	}

	/** The placeholder for a secret, minting one on first use. */
	#placeholderFor(entry: SecretEntry): string {
		for (const [placeholder, value] of this.#restorable) {
			if (value === entry.value) return placeholder;
		}
		const label = sanitizeFriendlyName(entry.friendlyName);
		// A label that is itself a known secret would put a credential inside the
		// placeholder, so it is dropped rather than sanitized around.
		const safeLabel = label && !this.#secretValues.has(label) ? label : undefined;
		const token = `$$${safeLabel ? `${safeLabel}_` : ""}${this.#allocateBase()}$$`;
		this.#restorable.set(token, entry.value);
		return token;
	}

	/**
	 * Replaces every known secret in a string.
	 *
	 * Idempotent: a second pass leaves existing placeholders alone, because no
	 * configured secret appears inside a token this redactor minted. That is what
	 * makes a redact-project-restore-redact round trip safe.
	 */
	redact(text: string): string {
		if (!text || this.isEmpty) return text;
		let output = text;
		for (const entry of this.#byValue.values()) {
			if (!isRedactable(entry.value)) continue;
			output = output.split(entry.value).join(this.#placeholderFor(entry));
		}
		return output;
	}

	/**
	 * Puts real values back into text addressed by this redactor's placeholders.
	 *
	 * Fail-closed two ways: a placeholder this process never minted is left as
	 * literal text, and a token whose label is a known secret is refused. The
	 * replacement is single-pass, so a secret that itself contains a
	 * placeholder-shaped substring cannot trigger a second expansion.
	 */
	restore(text: string): string {
		if (!text || this.isEmpty) return text;
		PLACEHOLDER_PATTERN.lastIndex = 0;
		return text.replace(PLACEHOLDER_PATTERN, (candidate) => {
			const restored = this.#restorable.get(candidate);
			if (restored === undefined) return candidate;
			const label = /^\$\$([A-Z0-9]{2,32})?_/.exec(candidate)?.[1];
			// A forged token that embeds a credential in its label is not honoured.
			if (label && this.#secretValues.has(label)) return candidate;
			return restored;
		});
	}

	/**
	 * Whether a string still contains any known secret.
	 *
	 * An assertion for the provider boundary: a payload that fails this must not
	 * be sent. One that passes still gets redacted — this is a backstop, not the
	 * mechanism.
	 */
	containsSecret(text: string): boolean {
		if (!text || this.isEmpty) return false;
		for (const value of this.#secretValues) {
			if (isRedactable(value) && text.includes(value)) return true;
		}
		return false;
	}

	/**
	 * True when the text ends inside an unterminated placeholder.
	 *
	 * **The doc this replaced claimed a stream could split a placeholder across
	 * deltas.** That is not true of this codebase, and the claim is what kept this
	 * member looking necessary. The display boundary is
	 * `AssistantMessageComponent.updateContent`, which redacts the whole accumulated
	 * message on every `message_update`; the outbound boundary is
	 * `AgentSession._redactProjection`, which redacts whole messages too. Neither ever
	 * redacts a single delta, so a split placeholder never reaches either.
	 *
	 * The method itself is correct and is retained: text assembled by *concatenation*
	 * rather than by a re-read of the full message can still land mid-token, and a
	 * caller that concatenates needs to know. Its justification is now the one that is
	 * actually true.
	 *
	 * Scanning forward from the *first* `$$` and checking whether a closing delimiter
	 * exists anywhere after it avoids mistaking the closing `$$` of a complete token
	 * for an opening one.
	 */
	hasPartialPlaceholder(text: string): boolean {
		if (!text) return false;
		let from = 0;
		while (true) {
			const open = text.indexOf(PLACEHOLDER_OPEN, from);
			if (open === -1) return false;
			const close = text.indexOf(PLACEHOLDER_OPEN, open + PLACEHOLDER_OPEN.length);
			// An opening `$$` with no partner anywhere after it: the tail is partial.
			if (close === -1) return true;
			from = close + PLACEHOLDER_OPEN.length;
		}
	}
}

/**
 * Irreversible masking, for surfaces that must never carry a secret.
 *
 * Unlike `redact`, this produces no restorable token, so it is safe for logs and
 * public output where a placeholder map would be inappropriate.
 */
export function maskSecret(value: string): string {
	return "*".repeat(Math.min(Math.max(value.length, 4), 64));
}
