import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { createWindowsNamedPipeServer, getWindowsNamedPipePath } from "@earendil-works/pi-server/windows-named-pipe";

/**
 * One local endpoint, resolved per platform.
 *
 * The Unix path is a `0600` socket inside a `0700` directory, so the operating system
 * already restricts it to the owner and no credential is needed. The Windows path is a
 * named pipe, whose ACL `node:net` cannot set, so the same property comes from a credential
 * the server requires in its `hello` frame.
 *
 * Keeping the choice here rather than at each call site is what stops a future caller from
 * binding a Unix path on Windows — the failure this module exists to remove.
 */
export type LocalServerEndpoint =
	| { readonly platform: "posix"; readonly path: string }
	| { readonly platform: "win32"; readonly path: string };

/**
 * The host contract, taken from the module that constructs the server.
 *
 * Derived rather than imported from the package root on purpose: the root subpath
 * resolves to  under the build while the transport subpaths resolve to ,
 * so naming both would make TypeScript treat  as two unrelated classes. The Unix
 * transport is the one every platform also uses, so its parameter type is the reference.
 */
export type LocalServerHost<TMetadata extends SessionMetadata = SessionMetadata> = Parameters<
	typeof createUnixServer<TMetadata>
>[0];

/** Derive the endpoint for one logical server identity and generation nonce. */
export function resolveServerEndpoint(serverId: string, directory: string, serverNonce: string): LocalServerEndpoint {
	if (process.platform === "win32") {
		return { platform: "win32", path: getWindowsNamedPipePath(serverId, serverNonce) };
	}
	return { platform: "posix", path: getUnixSocketPath(serverId, directory) };
}

/**
 * Create the platform-appropriate local server.
 *
 * `authToken` is required on Windows and ignored on POSIX. It must be a secret the
 * connecting peer already holds — never derived from the endpoint name, which any local
 * process can enumerate.
 */
export function createLocalServer<TMetadata extends SessionMetadata>(
	host: LocalServerHost<TMetadata>,
	options: {
		serverId: string;
		endpoint: LocalServerEndpoint;
		authToken?: string;
		onConnectionCountChanged?: (count: number) => void;
		onError?: (error: Error) => void;
	},
): ReturnType<typeof createUnixServer<TMetadata>> {
	if (options.endpoint.platform === "win32") {
		if (options.authToken === undefined) {
			throw new Error(
				"createLocalServer on Windows requires authToken: a named pipe cannot be restricted to the owner by node:net, so the credential is what proves a connecting process is the intended peer",
			);
		}
		return createWindowsNamedPipeServer(host, {
			serverId: options.serverId,
			path: options.endpoint.path,
			authToken: options.authToken,
			onConnectionCountChanged: options.onConnectionCountChanged,
			onError: options.onError,
		});
	}
	return createUnixServer(host, {
		serverId: options.serverId,
		path: options.endpoint.path,
		mode: 0o600,
		onConnectionCountChanged: options.onConnectionCountChanged,
		onError: options.onError,
	});
}

/** A path a client can hand to `net`, for the given endpoint. */
export function endpointPath(endpoint: LocalServerEndpoint): string {
	return endpoint.path;
}

/** The per-generation control endpoint, used by the coordinator lease. */
export function controlEndpointPath(serverId: string, directory: string, serverNonce: string): string {
	if (process.platform === "win32") {
		// The coordinator's control endpoint. Labelled distinctly from the server endpoint so
		// the two cannot derive the same pipe name — hashing one nonce for both made them
		// identical, and the server then failed to bind with EADDRINUSE against the coordinator
		// that was already holding it.
		return getWindowsNamedPipePath(serverId, distinctGenerationNonce(serverNonce, "control"));
	}
	return join(directory, `control-${serverId}.sock`);
}

/** The coordinator-facing server endpoint, distinct from both the control and public routes. */
export function serverEndpointPath(serverId: string, directory: string, serverNonce: string): string {
	if (process.platform === "win32") {
		return getWindowsNamedPipePath(serverId, distinctGenerationNonce(serverNonce, "server"));
	}
	return join(directory, `server-${serverId}-${serverNonce}.sock`);
}

/**
 * Derive a second, distinct, still-valid nonce from one generation nonce.
 *
 * The control endpoint must not share a name with the public endpoint, and the name is
 * validated as lowercase hex, so the discriminator is produced by hashing rather than by
 * appending a letter — `abc` and `abcs` differ, but `abcs` is not hex.
 */
export function distinctGenerationNonce(nonce: string, label: string): string {
	// `label` is required: deriving two endpoints from one nonce with the same label yields
	// the same name, which is a silent endpoint collision.
	const digest = createHash("sha256").update(`${label}\0${nonce}`).digest("hex").slice(0, 12);
	return /^[0-9a-f]{12}$/.test(digest) ? digest : nonce;
}
