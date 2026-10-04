import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";

/**
 * Windows local-endpoint discovery.
 *
 * ## Why this exists
 *
 * POSIX discovery is a directory scan (`packages/client/src/unix.ts:47`): a socket is a
 * filesystem entry, so `readdir` finds every live server. A Windows named pipe is a kernel
 * object with **no directory entry**, and Node exposes no way to enumerate pipes owned by
 * other processes. So there is nothing to scan, and without this module a Windows client can
 * only ever reach a server it started itself.
 *
 * ## Discovery is not authority
 *
 * **A registry entry nominates a candidate endpoint. It never establishes one.**
 *
 *     registry  ->  candidate endpoint  ->  connect  ->  transport authentication
 *                                                        (the `hello` credential)
 *                                                    ->  usable server
 *
 * An entry is a filename plus a PID. Neither is proof of anything:
 *
 * - a local process can write a file naming any pipe, including one it created itself;
 * - a PID can be reused, so `pid` alone never proves identity.
 *
 * So nothing here is trusted. Every entry is **candidacy only**, and the existing
 * `ServerListener` credential check — `credentialsMatch`, constant-time, enforced in
 * `Server.finishHandshake` before any service is attached — remains the sole authority.
 * A tampered entry can at worst cause a connection attempt that the credential gate
 * refuses, which is the same failure a client gets from a stale socket file.
 *
 * This mirrors current OMP, which uses exactly this shape for its collab registry
 * (`collab/registry.ts`): an unpredictable per-publication id names a metadata file
 * written `0600` via `open(wx)` + rename, a lister `readdir`s the directory and
 * **re-probes every candidate**, and pruning happens only on positive evidence of death
 * (`ENOENT`/`ECONNREFUSED`), never on a timeout or a parse error.
 *
 * ## Location
 *
 * `~/.pi/server/endpoints/`, resolved through the existing authority
 * `resolveServerDirectory()` (`PI_SERVER_DIR` or `~/.pi/server`). No new configuration
 * root: the directory is already created per-user by `ensurePrivateServerDirectory` and
 * is the same directory whose `0700` mode makes POSIX socket permissions meaningful.
 *
 * ## Format
 *
 * One JSON file per server, named by its `serverId`:
 *
 *     { "version": 1, "serverId": "<uuidv4>", "endpoint": "\\\\.\\pipe\\pi-<id>-<nonce>",
 *       "pid": 12345, "createdAt": "2026-10-04T…" }
 *
 * No credential is written. The bearer token is exchanged out of band, exactly as on the
 * transport, and the registry could not help an attacker reach a server even if it leaked.
 *
 * Named by `serverId` rather than by a random publication id, because multi-server
 * selection needs a **deterministic** identity: two servers in one directory must be
 * distinguishable, and one server must be able to replace its own entry without
 * inheriting a predecessor's.
 */

/** Bumped when the entry shape changes incompatibly. Unknown versions are ignored, not guessed at. */
export const ENDPOINT_REGISTRY_VERSION = 1 as const;

const ENDPOINT_SUBDIRECTORY = "endpoints";
const ENTRY_SUFFIX = ".json";
/** Entries older than this with a dead pid are prunable. A grace period, never a liveness claim. */
const DEFAULT_STALE_MS = 5 * 60_000;

export interface EndpointRegistryEntry {
	readonly version: typeof ENDPOINT_REGISTRY_VERSION;
	readonly serverId: ServerId;
	/** The full pipe name, including the `\\.\pipe\` prefix. */
	readonly endpoint: string;
	readonly pid: number;
	readonly createdAt: string;
}

export interface DiscoverEndpointOptions {
	/** Entries older than this whose pid is dead are removed. Defaults to five minutes. */
	staleMs?: number;
	/**
	 * Prove a candidate is usable. Called for every entry; the returned value decides
	 * whether it becomes a route. **The implementation must connect and authenticate** —
	 * an entry is never a usable route on the strength of existing in a file.
	 */
	probe: (entry: EndpointRegistryEntry) => Promise<boolean>;
}

/** The registry directory for a server directory. Created on demand by {@link publishEndpoint}. */
export function endpointRegistryDirectory(serverDirectory: string): string {
	return join(serverDirectory, ENDPOINT_SUBDIRECTORY);
}

function entryPath(directory: string, serverId: ServerId): string {
	return join(directory, `${serverId}${ENTRY_SUFFIX}`);
}

/** Accept only the shape we wrote. Anything else is ignored, never partially believed. */
function parseEntry(raw: string): EndpointRegistryEntry | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== ENDPOINT_REGISTRY_VERSION) return undefined;
	if (!isServerId(candidate.serverId)) return undefined;
	if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) return undefined;
	// The prefix check is a parse-time sanity check, **not** an authorisation: it rejects a
	// file that names something other than a pipe, so a malformed entry cannot redirect a
	// client at an arbitrary filesystem path or host:port.
	if (!candidate.endpoint.startsWith("\\\\.\\pipe\\")) return undefined;
	if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return undefined;
	if (typeof candidate.createdAt !== "string" || candidate.createdAt.length === 0) return undefined;
	return {
		version: ENDPOINT_REGISTRY_VERSION,
		serverId: candidate.serverId,
		endpoint: candidate.endpoint,
		pid: candidate.pid,
		createdAt: candidate.createdAt,
	};
}

/** True when the process id is still in use. Never a claim about *which* process. */
function pidAlive(pid: number): boolean {
	try {
		// Signal 0 tests for existence without delivering anything. It answers "is some
		// process using this pid", never "is this the process that wrote the entry" — which
		// is why liveness alone never makes an entry selectable.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function entryAgeMs(entry: EndpointRegistryEntry): number {
	const created = Date.parse(entry.createdAt);
	if (Number.isNaN(created)) return Number.POSITIVE_INFINITY;
	return Date.now() - created;
}

/**
 * Register this server's endpoint.
 *
 * Atomic: written to a unique temporary name in the same directory, then `rename`d over the
 * target. `rename` within a directory is atomic on POSIX and on Windows, so a reader sees
 * either the previous entry or the new one — never a partial write. Two servers registering
 * concurrently write distinct filenames, so neither can lose the other's entry; a server
 * re-registering replaces only its own.
 *
 * `mkdir` is `recursive`, so concurrent first registrations cannot fail each other.
 */
export async function publishEndpoint(
	serverDirectory: string,
	entry: Omit<EndpointRegistryEntry, "version">,
): Promise<EndpointRegistryEntry> {
	const directory = endpointRegistryDirectory(serverDirectory);
	// recursive, so two servers registering for the first time cannot fail each other.
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const complete: EndpointRegistryEntry = { version: ENDPOINT_REGISTRY_VERSION, ...entry };
	const target = entryPath(directory, entry.serverId);
	// A unique temporary name in the same directory: the rename is then same-filesystem and
	// atomic, and two writers can never collide on the scratch file.
	const temporary = join(directory, `.${entry.serverId}.${randomSuffix()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(complete)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	return complete;
}

/**
 * Remove this server's registration, and only its own.
 *
 * The file name is derived from the `serverId`, so a shutdown cannot remove another
 * principal's entry even if given the wrong identity by mistake.
 */
export async function retractEndpoint(serverDirectory: string, serverId: ServerId): Promise<void> {
	await rm(entryPath(endpointRegistryDirectory(serverDirectory), serverId), { force: true });
}

/**
 * List candidates and prune entries proven dead.
 *
 * Pruning is deliberately timid, following OMP: an entry is removed only when a probe
 * fails **and** the failure is positive evidence — the pid is dead and the entry is older
 * than the grace period. A timeout, a transient error, or an entry we failed to parse is
 * left alone, because deleting a live server's registration on a bad read is far worse than
 * keeping a stale file for another round.
 */
export async function discoverEndpoints(
	serverDirectory: string,
	options: DiscoverEndpointOptions,
): Promise<EndpointRegistryEntry[]> {
	const directory = endpointRegistryDirectory(serverDirectory);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) return [];
		throw error;
	}

	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const routes: EndpointRegistryEntry[] = [];
	const prunable: string[] = [];

	for (const name of names) {
		if (!name.endsWith(ENTRY_SUFFIX) || name.startsWith(".")) continue;
		const path = join(directory, name);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if (!isErrnoCode(error, "ENOENT")) throw error;
			continue;
		}
		const entry = parseEntry(raw);
		if (!entry) {
			// Unparseable or wrong-version. Left in place rather than deleted: we cannot tell
			// a corrupt file from one written by a newer version, and removing either would
			// destroy state we do not own.
			continue;
		}
		// The filename must agree with the contents, so a renamed or hand-edited file cannot
		// present one identity under another's name.
		if (`${entry.serverId}${ENTRY_SUFFIX}` !== name) continue;

		let usable = false;
		try {
			usable = await options.probe(entry);
		} catch {
			// A probe that throws is not evidence of death. Leave the entry and try again next
			// time, which is exactly the behaviour OMP's `skip` classification gives.
			continue;
		}
		if (usable) {
			routes.push(entry);
			continue;
		}
		// Proven unusable. Prune only with positive evidence *and* past the grace period,
		// so a server that is mid-restart keeps its registration.
		if (entryAgeMs(entry) > staleMs && !pidAlive(entry.pid)) prunable.push(path);
	}

	await Promise.all(prunable.map((path) => rm(path, { force: true }).catch(() => undefined)));
	return routes.sort((left, right) => left.serverId.localeCompare(right.serverId));
}

function randomSuffix(): string {
	return createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
