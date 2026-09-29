/**
 * Language-server identity for a shared mux.
 *
 * ## What sharing means
 *
 * One language server per project is shared across sessions rather than one per
 * session. A language server is expensive to start - indexing a repository takes
 * seconds to minutes - so sharing is worth a lot.
 *
 * ## The identity must include everything that changes behaviour
 *
 * A server is started with a command, arguments, a working directory and an
 * environment. Two links agreeing on command and cwd but differing in args or
 * env are **not interchangeable**: keying on those two alone would hand an idle
 * server started with one argument set to a link that asked for another, and the
 * client would believe it had configured something it had not.
 *
 * ## Two details that are load-bearing
 *
 * **Env keys are sorted.** A process environment's insertion order is not
 * meaningful, and two links built the same way can enumerate it differently.
 * Without sorting, one identity splits in two and a second server starts for no
 * reason.
 *
 * **Every part is JSON-encoded before joining.** Otherwise a separator can be
 * forged from a value: the argument list `["--log-level", "4"]` and the single
 * argument `["--log-level 4"]` would produce the same key.
 *
 * ## Why the result is hashed
 *
 * The key is returned over the handshake and written into mux logs. A raw
 * environment can hold `ANTHROPIC_API_KEY` and the rest, and neither surface
 * should carry it. A SHA-256 of the canonical identity is stable, comparable and
 * reveals nothing.
 */

import { createHash } from "node:crypto";

/** What a client asks the mux to start or reuse. */
export interface MuxConnectParams {
	readonly command: string;
	readonly args?: readonly string[];
	/** The working directory the server runs in. */
	readonly cwd: string;
	/** Extra environment, merged over the process environment. */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * The canonical identity of a language server.
 *
 * Every part is JSON-encoded rather than concatenated, so no separator can be
 * forged from a value and no enumeration order can change the result.
 */
export function muxServerKey(params: MuxConnectParams): string {
	// Sorted so object insertion order never splits one identity in two.
	const envEntries = Object.entries(params.env ?? {}).sort((left, right) => (left[0] < right[0] ? -1 : 1));
	const identity = JSON.stringify([params.command, params.args ?? [], params.cwd, envEntries]);
	// Hashed because the key travels over the handshake and into logs, and a raw
	// environment holds credentials.
	return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

/** How a server is obtained. */
export type ServerAcquisition = "shared" | "private";

export interface AcquireResult {
	readonly acquisition: ServerAcquisition;
	readonly key: string;
	readonly reason: string;
}

/**
 * Decides whether a link can use a shared server or needs a private one.
 *
 * A client that cannot reach the broker falls back to a **private** server
 * rather than failing. That is the whole point of the fallback: a user with no
 * daemon still gets working language intelligence, just the slower kind, and
 * never an error they cannot act on.
 */
export function acquireServer(input: {
	readonly params: MuxConnectParams;
	readonly shared: boolean;
	/** Whether a shared server for this key already exists. */
	readonly existingShared?: boolean;
	/** Whether the broker is reachable at all. */
	readonly brokerAvailable: boolean;
}): AcquireResult {
	const key = muxServerKey(input.params);
	if (!input.shared) {
		return { acquisition: "private", key, reason: "sharing is switched off" };
	}
	if (!input.brokerAvailable) {
		// A user with no daemon still gets working language intelligence, just the
		// slower kind - never an error they cannot act on.
		return { acquisition: "private", key, reason: "the broker is unreachable, so a private server is used" };
	}
	return {
		acquisition: "shared",
		key,
		reason: input.existingShared
			? "reusing the shared server for this identity"
			: "starting the shared server for this identity",
	};
}

/** Whether a key identifies a server that is already running. */
export function isSharedKeyInUse(keys: Iterable<string>, key: string): boolean {
	for (const candidate of keys) if (candidate === key) return true;
	return false;
}

/**
 * Whether a key may be shown to a user or written to a log.
 *
 * Always true, and the point is that a caller never has to ask. A raw key would
 * be readable and a caller might reasonably include it.
 */
export function isRedactedKey(key: string): boolean {
	return key.startsWith("sha256:");
}
