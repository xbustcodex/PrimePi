/**
 * Update checking: noticing a new version without ever installing one.
 *
 * ## The distinction this module exists to preserve
 *
 * **Checking is not updating.** PrimePi forbids automatic self-replacement: a
 * build that silently swaps itself for a different one is a build the user did
 * not choose, running on a machine they were not watching.
 *
 * A *check* is the opposite of that. It reads a published version, compares it
 * to the running one, and reports a difference. Nothing is fetched into place,
 * nothing is executed, and a user who ignores the notice has lost nothing.
 *
 * So the whole of this module is the boundary: what may be read, what may be
 * compared, and what may never happen as a result.
 *
 * ## A customized build reports itself differently
 *
 * A working tree that has been modified is not a released build, and a diff
 * against a release number would be meaningless - it would either report nothing
 * or report noise. So a customized build is reported as *unverifiable* rather
 * than as up to date or out of date, because neither answer would be true.
 *
 * ## A canary is opt-in and stated
 *
 * A canary reports a build that is expected to break. Choosing it is a real
 * choice with a real cost, so the notice says what the cost is rather than
 * presenting the version like any other.
 */

/** Which stream a build belongs to. */
export type UpdateChannel = "stable" | "canary";

/** What the running build is. */
export type BuildKind = "released" | "customized" | "development";

export interface UpdateCheckInput {
	/** The running build. */
	readonly build: BuildKind;
	readonly currentVersion: string;
	/** The channel to check. */
	readonly channel: UpdateChannel;
	/** The newest version on that channel, when the check succeeded. */
	readonly latestVersion?: string;
	/** Whether the check itself failed. */
	readonly checkFailed?: boolean;
}

export type UpdateVerdict =
	| { readonly kind: "up-to-date"; readonly message: string }
	| { readonly kind: "update-available"; readonly message: string; readonly latest: string }
	| { readonly kind: "unverifiable"; readonly message: string }
	| { readonly kind: "check-failed"; readonly message: string }
	| { readonly kind: "disabled"; readonly message: string };

/**
 * Compares versions without executing or fetching anything.
 *
 * The return value is a *notice*. There is deliberately no branch here that
 * downloads, extracts, or replaces: a caller that wanted automatic updating
 * would find no path to it, which is the point.
 */
export function evaluateUpdateCheck(input: UpdateCheckInput, enabled: boolean): UpdateVerdict {
	if (!enabled) {
		return { kind: "disabled", message: "update checking is off" };
	}
	if (input.build === "development" || input.build === "customized") {
		// A modified tree is not a released build, so a diff against a release number
		// would be meaningless - it would report nothing or report noise, and neither
		// answer would be true.
		return {
			kind: "unverifiable",
			message: "this is a working build, so it cannot be compared against a published release",
		};
	}
	if (input.checkFailed || !input.latestVersion) {
		return { kind: "check-failed", message: "the update check did not complete" };
	}
	if (compareVersions(input.latestVersion, input.currentVersion) > 0) {
		const note = input.channel === "canary" ? " on a canary channel, which is expected to break" : "";
		return {
			kind: "update-available",
			latest: input.latestVersion,
			message: `version ${input.latestVersion} is available${note}. Nothing has been downloaded or installed.`,
		};
	}
	return { kind: "up-to-date", message: `version ${input.currentVersion} is the latest on this channel` };
}

/**
 * Compares two dotted versions.
 *
 * Missing components read as zero, so `1.2` and `1.2.0` are equal rather than
 * ordered arbitrarily - a build tagged `1.2.0` must not be told it is behind
 * `1.2`.
 */
export function compareVersions(left: string, right: string): number {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return 0;
}

function parseVersion(value: string): number[] {
	return value
		.trim()
		.replace(/^v/i, "")
		.split(".")
		.map((part) => {
			const numeric = Number.parseInt(part, 10);
			// A pre-release or build suffix is not a version component, and reading it
			// as one would order `1.0.0-rc1` above `1.0.0`.
			return Number.isFinite(numeric) ? numeric : 0;
		});
}

/** One line for a settings hint, stating what the setting does not do. */
export function describeUpdateCheck(channel: UpdateChannel): string {
	return channel === "canary"
		? "Checks the canary channel, which is expected to break. This never downloads or installs anything."
		: "Checks the stable channel for a newer version. This never downloads or installs anything.";
}
