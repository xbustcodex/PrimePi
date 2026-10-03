import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import { Server } from "../../server.ts";
import type { ServerHost } from "../../types.ts";
import { createWindowsNamedPipeListener } from "./listener.ts";
import type { WindowsNamedPipeServerOptions } from "./types.ts";

/**
 * Compose a Server with one Windows named-pipe listener.
 *
 * The Unix counterpart is `transports/unix/preset.ts`; the only difference is that
 * `authToken` is expected to be set here, because a named pipe cannot be restricted to
 * the owner by `node:net`. It is not *enforced* at this layer — `Server.finishHandshake`
 * compares whatever token it was given — so a caller that leaves it undefined gets a
 * pipe reachable by any local process. The warning below makes that explicit rather than
 * letting it be discovered in production.
 */
export function createWindowsNamedPipeServer<TMetadata extends SessionMetadata>(
	host: ServerHost<TMetadata>,
	options: WindowsNamedPipeServerOptions,
): Server<TMetadata> {
	if (options.authToken === undefined) {
		process.emitWarning(
			"createWindowsNamedPipeServer without authToken: the named pipe will be reachable by any local process, because node:net cannot set a pipe's security descriptor. Pass authToken unless another layer authenticates every connection.",
			"WindowsNamedPipeServerMissingAuthToken",
		);
	}
	const listener = createWindowsNamedPipeListener({
		path: options.path,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new Server(host, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		onConnectionCountChanged: options.onConnectionCountChanged,
		serverId: options.serverId,
		onError: options.onError,
		authToken: options.authToken,
	});
}
