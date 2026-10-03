const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Derive the local Windows named-pipe name for one logical server identity.
 *
 * The Unix path (`transports/unix/address.ts`) appends `.sock` inside a `0700`
 * directory. There is no directory here and no permission bit to set: a named pipe's
 * reachability is governed by its DACL, which `node:net` cannot configure, so access is
 * instead gated by the credential the server requires in its `hello` frame.
 *
 * `nonce` is the same per-generation discriminator the Unix route already carries —
 * `experimental/server.ts` builds `server-<serverId>-<serverNonce>.sock`. On Unix it is
 * defence in depth behind the directory permissions. On Windows it is what stops one
 * server generation's clients from reaching another's endpoint, so it is validated here
 * rather than trusted.
 *
 * @param serverId canonical lowercase UUIDv4, as on the Unix path
 * @param nonce opaque per-generation discriminator, 32 lowercase hex characters
 * @param prefix pipe namespace; defaults to `pi`
 */
export function getWindowsNamedPipePath(serverId: string, nonce: string, prefix = "pi"): string {
	if (!UUID_V4.test(serverId)) {
		throw new TypeError("Windows named-pipe serverId must be a canonical lowercase UUIDv4");
	}
	if (!/^[0-9a-f]{32}$/.test(nonce)) {
		throw new TypeError("Windows named-pipe nonce must be 32 lowercase hexadecimal characters");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
		throw new TypeError("Windows named-pipe prefix must contain only alphanumerics, dot, underscore or hyphen");
	}
	return `\\\\.\\pipe\\${prefix}-${serverId}-${nonce}`;
}

/** The stable directory-less server route for one identity, for callers that only need a name. */
export function getWindowsServerPipePath(serverId: string, prefix = "pi"): string {
	if (!UUID_V4.test(serverId)) {
		throw new TypeError("Windows named-pipe serverId must be a canonical lowercase UUIDv4");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
		throw new TypeError("Windows named-pipe prefix must contain only alphanumerics, dot, underscore or hyphen");
	}
	return `\\\\.\\pipe\\${prefix}-server-${serverId}`;
}
