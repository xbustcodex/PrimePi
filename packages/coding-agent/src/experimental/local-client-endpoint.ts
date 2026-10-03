import type { ByteTransportFactory } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { createWindowsNamedPipeTransportFactory } from "@earendil-works/pi-client/windows-named-pipe";
import type { ServerId } from "@earendil-works/pi-protocol";

/**
 * The platform's local endpoint, as the client sees it.
 *
 * On POSIX this is a `0600` socket inside a `0700` directory, so the operating system
 * already restricts it to the owner and no credential is involved. On Windows it is a
 * named pipe whose ACL `node:net` cannot set, so the client must present the credential the
 * server requires in its `hello` frame; without it the server refuses before attaching any
 * service.
 *
 * The two are deliberately distinguishable: a route names `named-pipe` on Windows rather
 * than reporting `unix`, so the reconnect and error paths can treat them differently and an
 * error never claims a pipe is a socket.
 */
export type LocalClientRoute =
	| { readonly transport: "unix"; readonly serverId: ServerId; readonly path: string }
	| { readonly transport: "named-pipe"; readonly serverId: ServerId; readonly path: string };

/** True when this platform's local endpoint is a named pipe rather than a Unix socket. */
export function localEndpointIsNamedPipe(): boolean {
	return process.platform === "win32";
}

/**
 * Build the transport for one local route.
 *
 * `authToken` is required on Windows and ignored on POSIX. It must arrive out of band — from
 * the launcher or an explicit option — never derived from the endpoint name, which any local
 * process can enumerate.
 */
export function createLocalTransportFactory(
	route: Pick<LocalClientRoute, "transport" | "path">,
	authToken?: string,
): ByteTransportFactory {
	if (route.transport === "named-pipe") {
		if (authToken === undefined || authToken.length === 0) {
			throw new Error(
				"A named-pipe server requires an auth token: a Windows pipe cannot be restricted to the owner by node:net, so the credential is what proves this client is the intended peer",
			);
		}
		return createWindowsNamedPipeTransportFactory({ path: route.path });
	}
	return createUnixTransportFactory({ path: route.path });
}

/**
 * Where a shared local credential comes from.
 *
 * A named pipe needs one; a Unix socket does not. Read from the environment so a launcher
 * and a client agree without either writing the secret into the endpoint name or a config
 * file the pipe's reachability would otherwise expose.
 */
export function localAuthTokenFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.PI_SERVER_AUTH_TOKEN;
}

/** Derive the route for an endpoint path on this platform. */
export function localRouteForPath(serverId: ServerId, path: string): LocalClientRoute {
	return localEndpointIsNamedPipe()
		? { transport: "named-pipe", serverId, path }
		: { transport: "unix", serverId, path };
}
