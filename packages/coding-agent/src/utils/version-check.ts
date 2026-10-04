import { compare, valid } from "semver";
import { PACKAGE_NAME, UPDATE_CHANNEL } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	/** Release channel the announcement belongs to, when the authority declares one. */
	channel?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		channel?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const channel = typeof data.channel === "string" && data.channel.trim() ? data.channel.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(channel ? { channel } : {}),
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

/**
 * Whether an announced release belongs to **this** product's release channel.
 *
 * The version endpoint is upstream Pi's, and it answers with
 * `@earendil-works/pi-coding-agent` — which is also *our* inherited npm package name, so
 * comparing package names cannot discriminate. Upstream's payload also carries no
 * `channel`, so requiring ours rejects it.
 *
 * If this product has no declared channel, there is no way to tell an upstream release
 * from one of ours, so nothing is treated as an update. That is the conservative
 * direction: the user is never told to run an update for a package they did not install.
 */
export function releaseMatchesThisProduct(
	release: LatestPiRelease,
	thisChannel: string | undefined = UPDATE_CHANNEL,
	thisPackageName: string = PACKAGE_NAME,
): boolean {
	if (thisChannel === undefined) return false;
	if (release.channel !== thisChannel) return false;
	// Belt and braces: a channel match alone is not enough if the payload also names a
	// different package.
	if (release.packageName !== undefined && release.packageName !== thisPackageName) return false;
	return true;
}

export async function checkForNewPiVersion(
	currentVersion: string,
	thisChannel: string | undefined = UPDATE_CHANNEL,
	thisPackageName: string = PACKAGE_NAME,
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (!latestRelease) return undefined;
		// Upstream-awareness is kept for migration and parity work, but an upstream release
		// is not a Prime Pi update and must not be presented as one.
		if (!releaseMatchesThisProduct(latestRelease, thisChannel, thisPackageName)) return undefined;
		if (isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
