/**
 * The security scanner's redaction: what a scan may disclose.
 *
 * ## Why a scan needs redacting at all
 *
 * A security scan runs with credentials, names the accounts it would
 * authenticate against, and records an account identity on every finding. All of
 * that is necessary to run the scan and none of it belongs in a transcript: a
 * transcript is copied, shared, persisted and replayed, and a credential
 * embedded in one has leaked into places the user did not enumerate.
 *
 * So the boundary is between **what the scan needs** and **what the transcript
 * may carry**, and it is applied on the way out rather than on the way in - the
 * scan keeps what it needs, the transcript gets what it may.
 *
 * ## Keys are matched normalised, not literally
 *
 * `access_token`, `accessToken`, `ACCESS-TOKEN` and `AccessToken` are the same
 * key. A denylist matching raw spellings would be defeated by a scanner that
 * happened to serialise in camelCase, and the failure is silent: the value is
 * emitted, the transcript keeps it, and nothing reports that redaction ran.
 *
 * So the key is lowercased and stripped of every non-alphanumeric character
 * before comparison. That is what makes a denylist of this kind usable at all.
 *
 * ## The default is a named set, not a heuristic
 *
 * A key like `user` or `host` is not a secret and redacting it would make a
 * finding unreadable. A key like `token` is. The list is therefore explicit, and
 * its cost is a maintenance obligation rather than a correctness risk.
 *
 * ## When settings cannot be read, security stays off
 *
 * A namespace that is enabled because a read failed would expose security
 * findings to a model that was never granted them. The default for an
 * uninitialised or throwing settings read is the *off* value, so a failure to
 * read narrows access rather than widening it.
 */

import { createHash } from "node:crypto";

/**
 * Keys whose values are stripped from anything a transcript may carry.
 *
 * Compared after normalisation, so the stored form is already lowercased with
 * non-alphanumerics removed.
 */
const PRIVATE_KEYS: ReadonlySet<string> = new Set([
	"account",
	"accountid",
	"accesstoken",
	"apikey",
	"authorization",
	"clientsecret",
	"credentialid",
	"email",
	"orgid",
	"organizationid",
	"organizationname",
	"orgname",
	"password",
	"privatekey",
	"refreshtoken",
	"secret",
	"sessionid",
	"token",
	"authorizationheader",
]);

/**
 * Normalises a key for comparison.
 *
 * `access_token`, `accessToken` and `ACCESS-TOKEN` all become `accesstoken`, so
 * a denylist cannot be defeated by serialisation style.
 */
export function normalizePrivateKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Strips private fields from a value, recursively.
 *
 * Arrays are mapped element by element, and a primitive is returned unchanged.
 * Redaction is by *key*, so a secret that arrives as a bare string is not
 * caught - which is correct, because there is nothing to identify it by and a
 * blanket string scrub would corrupt every finding.
 */
export function redactPrivateMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactPrivateMetadata);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (PRIVATE_KEYS.has(normalizePrivateKey(key))) continue;
		result[key] = redactPrivateMetadata(item);
	}
	return result;
}

/**
 * A stable, non-reversible reference to a credential.
 *
 * A scan must be able to say "this finding is about the account I am already
 * authenticated as" without disclosing the account. A hash of a canonical form
 * does that, and it is one-way: a transcript carrying it reveals nothing even if
 * the credential list is guessable.
 */
export function credentialAffinity(account: unknown): string {
	return `primepi-security-credential/v1:sha256:${canonicalHash(account)}`;
}

/** A canonical JSON form, so key order and spacing cannot change the hash. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function canonicalHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Whether the security namespace is available, and why not when it is not. */
export type SecurityAvailability = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

/**
 * Decides whether the security namespace may be read.
 *
 * A failure to read the setting resolves to **off**. A namespace enabled
 * because a read failed would expose security findings to a model that was never
 * granted them, and that is the one direction of error that matters here.
 */
export function securityAvailability(input: {
	readonly settingsInitialized: boolean;
	/** Reading the setting threw, rather than returning a value. */
	readonly readFailed: boolean;
	readonly configured: boolean;
}): SecurityAvailability {
	if (input.readFailed || !input.settingsInitialized) {
		return {
			enabled: false,
			reason:
				"the security setting could not be read, so the namespace stays closed; a failure to read narrows access rather than widening it",
		};
	}
	if (!input.configured) {
		return { enabled: false, reason: "security:// is disabled. Enable it in Settings." };
	}
	return { enabled: true };
}

/** The refusal a model sees when the namespace is closed. */
export function securityDisabledMessage(): string {
	return "security:// is disabled. Enable it by setting `security.enabled = true` (Settings → Tools → Security).";
}
