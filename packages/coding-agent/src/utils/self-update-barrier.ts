/**
 * Hard barrier against this installation replacing itself.
 *
 * This build is a customized fork installed from a source checkout, so allowing
 * `pi update` to run would overwrite local changes with a published package. The
 * startup version notice (`interactive-mode.ts`) is deliberately left intact: it
 * only prints advisory text and never installs anything.
 *
 * The deliberate upgrade path is developer-controlled and lives outside Pi:
 * rebuild the working tree and re-link (see AGENTS.md, "Local Build and `pi`
 * Command"). Setting `PI_ALLOW_SELF_UPDATE=1` re-enables the upstream self-update
 * code paths for anyone who genuinely wants them.
 */

export const ALLOW_SELF_UPDATE_ENV = "PI_ALLOW_SELF_UPDATE";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/** True only when the operator explicitly opted back in to Pi replacing itself. */
export function isSelfUpdateAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
	return TRUTHY_VALUES.has((env[ALLOW_SELF_UPDATE_ENV] ?? "").trim().toLowerCase());
}

/** Operator-facing explanation for a blocked self-update. */
export function selfUpdateBlockedMessage(appName: string): string {
	return [
		`${appName} self-update is disabled: this installation is a customized local build and must not be replaced by a published package.`,
		`Rebuild it from source instead: npm run build`,
		`To re-enable upstream self-update deliberately, set ${ALLOW_SELF_UPDATE_ENV}=1.`,
	].join("\n");
}
