/**
 * Session sharing: what leaves the machine, and what must not.
 *
 * ## The leak boundary
 *
 * A share blob is published. Whatever it contains has left the user's
 * machine and, in the general case, is not under their control afterwards. That
 * makes sharing a different boundary from every other read, and it is why
 * redaction is a share concern rather than a display one.
 *
 * ## The rule that is easy to get wrong
 *
 * **Redaction is resolved against the session's own project directory, not the
 * invoking working directory.**
 *
 * A share command run from a different directory still shares a session that
 * *belongs* to some project. That project's `secrets.yml` holds the secrets that
 * session may have recorded, and its `share.redactSecrets` / `secrets.enabled`
 * settings are the ones that apply. Reading the invoking cwd's configuration
 * would apply the wrong policy to the wrong content — and the common case is
 * exactly the risky one: sharing an old session from wherever you happen to be.
 *
 * ## Redaction is conjunctive, and the order of the conditions does not matter
 *
 * A share redacts only when *both* the share setting and the global secrets
 * setting say so. That is deliberate: `share.redactSecrets` describes the
 * content boundary, and `secrets.enabled` describes whether the user treats
 * configured values as secrets at all. Either one off means the other does not
 * apply, and a single flag cannot silently opt a share out of redaction.
 *
 * ## Refusing is better than publishing
 *
 * If redaction is required and cannot be applied, the share does not proceed.
 * A published blob that *looks* redacted but was not is the worst outcome
 * available, and it is the one an absent-obfuscator path produces.
 */

/** Where a shared session's secrets come from. */
export interface ShareSource {
	/** The session's own project directory, which owns its secrets and policy. */
	readonly projectCwd: string;
	/** Whether the session's project redacts secrets. */
	readonly redactSecrets: boolean;
	/** Whether the session's project treats configured values as secrets. */
	readonly secretsEnabled: boolean;
	/** Whether an obfuscator could be built for that project. */
	readonly obfuscatorAvailable: boolean;
}

/** Where a share was invoked from, which is *not* what governs it. */
export interface ShareInvocation {
	/** The directory the command ran in. Recorded so the difference is visible. */
	readonly invokedFrom: string;
}

export type ShareDecision =
	| { readonly action: "share"; readonly redacted: true; readonly reason: string }
	| { readonly action: "share"; readonly redacted: false; readonly reason: string }
	| { readonly action: "refuse"; readonly reason: string };

/**
 * Decides whether a session may be shared, and with what redaction.
 *
 * `invocation` is accepted so a caller can see that it is deliberately unused:
 * the policy comes from the session, and threading the invoking directory into
 * the decision is the bug this exists to prevent.
 */
export function decideShare(source: ShareSource, invocation?: ShareInvocation): ShareDecision {
	// Referenced so the parameter is not dead, and so the difference is documented
	// at the point where it would otherwise be made.
	void invocation;

	if (source.redactSecrets && source.secretsEnabled) {
		if (!source.obfuscatorAvailable) {
			// Refusing beats publishing: a blob that looks redacted but was not is
			// worse than no blob at all.
			return {
				action: "refuse",
				reason: `redaction is required by ${source.projectCwd} but no obfuscator could be built for it`,
			};
		}
		return {
			action: "share",
			redacted: true,
			reason: `redacted against ${source.projectCwd}'s own secrets`,
		};
	}

	const disabledBy: string[] = [];
	if (!source.redactSecrets) disabledBy.push("share.redactSecrets");
	if (!source.secretsEnabled) disabledBy.push("secrets.enabled");
	return {
		action: "share",
		redacted: false,
		// Naming both, because a share that went out unredacted should say which
		// setting allowed it.
		reason: `not redacted: ${disabledBy.join(" and ")} disabled in ${source.projectCwd}`,
	};
}

/** A one-line warning for a share that went out without redaction. */
export function shareWarning(decision: ShareDecision): string | undefined {
	if (decision.action !== "share" || decision.redacted) return undefined;
	return "This session was shared WITHOUT secret redaction. Treat the published content as public.";
}

/** What the command reports to the user. */
export function describeShare(decision: ShareDecision, url: string): string[] {
	const lines = [`Share URL: ${url}`];
	const warning = shareWarning(decision);
	if (warning) lines.push(`Warning: ${warning}`);
	return lines;
}
