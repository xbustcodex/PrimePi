/**
 * Credential shapes recognized without configuration.
 *
 * ## Why these and not more
 *
 * Every pattern here is chosen so a false positive is both rare and harmless.
 * Each is anchored on a distinctive vendor prefix *and* a length that ordinary
 * text does not produce. That matters more than it might seem: a redactor that
 * redacts normal prose is a redactor operators learn to disable, so breadth is
 * not free.
 *
 * A pattern that would match a common word, a UUID-shaped identifier, or an
 * ordinary base64 blob is deliberately absent. Length thresholds here are set
 * high enough that a match is a strong signal on its own.
 */

/** One recognized credential shape. */
export interface CredentialPattern {
	/** Stable name for diagnostics. Never derived from a matched value. */
	name: string;
	/** Anchored, case-insensitive, global. */
	pattern: RegExp;
}

/**
 * Prefix-anchored vendor tokens.
 *
 * The prefix does the work; the length requirement rejects truncated matches,
 * which are the common false positive when this kind of pattern is too loose.
 */
export const BUILT_IN_CREDENTIAL_PATTERNS: readonly CredentialPattern[] = Object.freeze([
	{
		name: "github-token",
		pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})(?![A-Za-z0-9_])/g,
	},
	{ name: "gitlab-token", pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
	{
		name: "anthropic-key",
		pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g,
	},
	{
		name: "openai-key",
		pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
	},
	{ name: "aws-access-key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
	{ name: "google-api-key", pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g },
	{ name: "slack-token", pattern: /(?<![A-Za-z0-9-])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
	{ name: "npm-token", pattern: /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{30,}(?![A-Za-z0-9_-])/g },
	{
		name: "stripe-key",
		pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/g,
	},
	{ name: "huggingface-token", pattern: /(?<![A-Za-z0-9_-])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_-])/g },
	{ name: "sendgrid-key", pattern: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g },
	{
		name: "jwt",
		pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
	},
	{
		name: "private-key",
		pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
	},
]);

/**
 * `Authorization: Bearer …` headers.
 *
 * Matched only in the header form, never a bare token, because a 20-character
 * base64-ish run appears constantly in ordinary output.
 */
export const BEARER_TOKEN_PATTERN = /(?<=\bBearer )[A-Za-z0-9._~+/=-]{20,}/g;

/**
 * Environment variables whose values are treated as secrets.
 *
 * A name match alone is not enough — the value must also be long enough to be a
 * credential, so `TOKEN_MODE=off` is not redacted.
 */
export const SECRET_ENV_NAME_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Shortest env value we treat as a secret. Below this it is likely a flag. */
export const MIN_ENV_SECRET_LENGTH = 8;

/** A password embedded in a connection URL. */
export const CONNECTION_URL_PASSWORD_PATTERN = /(:\/\/[^:/\s]+:)([^@\s/]+)(@)/g;

/**
 * Whether a value is plausible as a secret rather than ordinary content.
 *
 * Entropy-gated on purpose: this is what keeps a long identifier or a base64
 * asset hash from being redacted, which would be noise the operator cannot act
 * on.
 */
export function hasPlausibleCredentialEntropy(value: string): boolean {
	if (value.length < 16) return false;

	// Real credentials mix character classes; a single-class run is usually a
	// hash, a word, or a padded number.
	const hasLower = /[a-z]/.test(value);
	const hasUpper = /[A-Z]/.test(value);
	const hasDigit = /[0-9]/.test(value);
	const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length;

	// A long all-hex or all-base64 run with no mixed case reads as content.
	const looksLikeHex = /^[0-9a-f]+$/i.test(value);
	if (looksLikeHex) return false;

	return classes >= 2;
}
