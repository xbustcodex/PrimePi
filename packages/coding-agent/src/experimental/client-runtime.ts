import { basename } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client, ServerError } from "@earendil-works/pi-client";
import { discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { discoverEndpoints, type EndpointRegistryEntry } from "./endpoint-registry.ts";
import {
	createLocalTransportFactory,
	localAuthTokenFromEnvironment,
	localEndpointIsNamedPipe,
	localRouteForPath,
} from "./local-client-endpoint.ts";
import { RadiusRelayAuthResolver } from "./radius-auth.ts";
import { createRadiusClientTransportFactory, RadiusClientReconnect } from "./radius-relay.ts";
import { activateServer, ENV_SERVER_ID, resolveServerDirectory, resolveSessionDirectory } from "./server.ts";
import { AgentController } from "./services/agent-controller.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type SessionServiceSource,
} from "./services/connection.ts";
import { Models } from "./services/models.ts";
import { PresentationPlugins } from "./services/plugins.ts";
import { SessionDirectory, SessionManagement } from "./services/sessions.ts";
import { Transcript } from "./services/transcript.ts";

export type ClientRuntimeRoute =
	| ({ readonly transport: "unix" } & UnixServerRoute)
	| ({ readonly transport: "named-pipe" } & UnixServerRoute)
	| { readonly transport: "radius"; readonly serverId: ServerId };

export interface ClientRuntimeServer {
	readonly route: ClientRuntimeRoute;
	readonly client: Client;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
}

export interface ActivatedClientRuntimeServer extends ClientRuntimeServer {
	readonly directory: SessionDirectory;
	readonly management: SessionManagement;
	readonly plugins: PresentationPlugins;
	readonly models: Models;
	readonly agent: AgentController;
	readonly transcript: Transcript;
}

export interface ClientRuntime {
	readonly servers: readonly ClientRuntimeServer[];
	dispose(): Promise<void>;
}

export interface OpenClientRuntimeOptions {
	/** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
}

/** Open live server/session service namespaces for one experimental presentation. */
export async function openClientRuntime(
	command: ClientCommand,
	options: OpenClientRuntimeOptions = {},
): Promise<ClientRuntime> {
	if (command.auth !== undefined && command.connect?.transport !== "radius") {
		throw new Error("Authentication is only supported for experimental Radius connections");
	}
	if (command.provider !== undefined && command.model === undefined) {
		throw new Error("Server model provider requires a model");
	}
	if (command.connect && command.model !== undefined) {
		throw new Error("Model selection is only valid when automatically activating a new server");
	}
	if (command.connect?.transport === "radius" && command.pluginPackages !== undefined) {
		throw new Error("Plugin package paths can only be configured on a local Unix server");
	}
	const directory = resolveServerDirectory(options.directory);
	let routes: ClientRuntimeRoute[];
	let activatedClient: Client | undefined;
	if (command.connect) {
		routes = [
			command.connect.transport === "radius"
				? { transport: "radius", serverId: command.connect.serverId }
				: localRouteForPath(routeFromExplicitPath(command.connect.path).serverId, command.connect.path),
		];
	} else if (localEndpointIsNamedPipe()) {
		// A named pipe has no directory entry, so there is nothing to scan and `discoverUnixServers`
		// cannot apply. Discovery on Windows means activating, which connects first and starts a
		// server only if nothing answers. That is the same shape as a POSIX scan that finds
		// nothing, and it needs no privileged enumeration of another process's endpoints.
		// A named pipe has no directory entry, so `discoverUnixServers` cannot apply.
		// Instead each server registers itself in the same directory, and every registered
		// candidate is **probed by connecting and completing the authenticated handshake** —
		// exactly what the POSIX scan does with a socket file. An entry naming a pipe no
		// reachable server answers on, or one that refuses our credential, is omitted rather
		// than trusted.
		//
		// So the registry nominates candidates and the transport authenticates them, in that
		// order. Nothing here can turn a file on disk into a usable server.
		const authToken = localAuthTokenFromEnvironment();
		const discovered = await discoverEndpoints(directory, {
			probe: (entry) => probeRegisteredEndpoint(entry, authToken),
		});
		routes = discovered.map((entry) => ({
			transport: "named-pipe" as const,
			serverId: entry.serverId,
			path: entry.endpoint,
		}));
		if (routes.length > 0 && command.model !== undefined) {
			throw new Error("Model selection is only valid when automatically activating a new server");
		}
		if (routes.length === 0) {
			const activated = await activateServer({
				directory,
				requestedServerId: process.env[ENV_SERVER_ID],
				sessionDir: resolveSessionDirectory(),
				provider: command.provider,
				model: command.model,
			});
			routes = [localRouteForPath(activated.route.serverId, activated.route.path)];
			activatedClient = activated.client;
		}
	} else {
		routes = (await discoverUnixServers({ directory })).map((route) => ({ transport: "unix", ...route }));
		if (routes.length > 0 && command.model !== undefined) {
			throw new Error("Model selection is only valid when automatically activating a new server");
		}
		if (routes.length === 0) {
			const activated = await activateServer({
				directory,
				requestedServerId: process.env[ENV_SERVER_ID],
				sessionDir: resolveSessionDirectory(),
				provider: command.provider,
				model: command.model,
			});
			routes = [localRouteForPath(activated.route.serverId, activated.route.path)];
			activatedClient = activated.client;
		}
	}
	if (command.pluginPackages !== undefined && routes.length !== 1) {
		throw new Error("Plugin selection requires exactly one local server");
	}

	const clients: Client[] = [];
	const reconnectors: RadiusClientReconnect[] = [];
	const serviceSources: Array<ServerServiceSource | SessionServiceSource> = [];
	const servers: ClientRuntimeServer[] = [];
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		const reconnectResults = await Promise.allSettled(reconnectors.map((reconnector) => reconnector.dispose()));
		const sourceResults = await Promise.allSettled(
			serviceSources.map((source) => source.dispose(BACKGROUND_CONTEXT)),
		);
		const clientResults = await Promise.allSettled(clients.map((client) => client.dispose()));
		const errors = [...reconnectResults, ...sourceResults, ...clientResults].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental client runtime");
	};

	try {
		for (const route of routes) {
			let client = activatedClient;
			if (client === undefined) {
				try {
					client = await Client.connect({
						serverId: route.serverId,
						// Required for a named pipe and ignored for a Unix socket, whose `0600`
						// mode inside a `0700` directory already restricts the endpoint to the
						// owner. See local-client-endpoint.ts for why the credential rather than
						// an ACL is what restricts a Windows pipe.
						authToken: route.transport === "radius" ? undefined : localAuthTokenFromEnvironment(),
						transportFactory:
							route.transport === "radius"
								? createRadiusClientTransportFactory({
										serverId: route.serverId,
										auth: new RadiusRelayAuthResolver(command.auth),
									})
								: createLocalTransportFactory(
										{ transport: route.transport, path: route.path },
										localAuthTokenFromEnvironment(),
									),
					});
				} catch (error) {
					if (
						command.connect !== undefined ||
						route.transport !== "unix" ||
						!(error instanceof ServerError) ||
						error.code !== "version"
					) {
						throw error;
					}
					client = (
						await activateServer({
							directory,
							requestedServerId: route.serverId,
							sessionDir: resolveSessionDirectory(),
						})
					).client;
				}
			}
			activatedClient = undefined;
			clients.push(client);
			const server = createServerServiceSource(client);
			serviceSources.push(server);
			if (route.transport === "radius") {
				const reconnectServices = server.open({
					services: [SessionManagement],
					assertAccess() {},
					onError() {},
				});
				const reconnectManagement = reconnectServices.use(SessionManagement);
				reconnectors.push(
					new RadiusClientReconnect(client, async (sessionId) => {
						await reconnectServices.ready(BACKGROUND_CONTEXT);
						await reconnectManagement.attach(sessionId, BACKGROUND_CONTEXT);
					}),
				);
			}
			const session = createSessionServiceSource(client);
			serviceSources.push(session);
			servers.push({ route, client, server, session });
		}
		return { servers, dispose };
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Experimental client startup and cleanup failed");
		}
		throw error;
	}
}

/** Acquire and connect the built-in service facades used by the non-interactive client. */
export async function activateBuiltinClientServices(
	server: ClientRuntimeServer,
): Promise<ActivatedClientRuntimeServer> {
	const serverServices = server.server.open({
		services: [SessionDirectory, SessionManagement, PresentationPlugins],
		assertAccess() {},
		onError() {},
	});
	const sessionServices = server.session.open({
		services: [Models, AgentController, Transcript],
		assertAccess() {},
		onError() {},
	});
	const directory = serverServices.use(SessionDirectory);
	const remoteManagement = serverServices.use(SessionManagement);
	const management: SessionManagement = {
		create: (options, context) => remoteManagement.create(options, context),
		async remove(sessionId, context) {
			const removesCurrentAttachment = server.client.attachment?.sessionId === sessionId;
			await remoteManagement.remove(sessionId, context);
			if (removesCurrentAttachment) await server.session.whenDetached(context);
		},
		async attach(sessionId, context) {
			await remoteManagement.attach(sessionId, context);
			await server.session.whenAttached(sessionId, context);
		},
		async detach(context) {
			await remoteManagement.detach(context);
			await server.session.whenDetached(context);
		},
	};
	const plugins = serverServices.use(PresentationPlugins);
	const models = sessionServices.use(Models);
	const agent = sessionServices.use(AgentController);
	const transcript = sessionServices.use(Transcript);
	await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
	return { ...server, directory, management, plugins, models, agent, transcript };
}

/**
 * Derive the server identity from an explicit `--connect` endpoint.
 *
 * The identity has to come from the endpoint, because a client with no other information
 * must refuse to talk to a server it cannot name. Two endpoint shapes are accepted, one
 * per platform:
 *
 *   POSIX   `<directory>/<uuidv4>.sock`         the id is the filename minus the suffix
 *   Windows `\\.\pipe\pi-<uuidv4>-<nonce>`    the id is the second-to-last segment
 *
 * The Windows form is parsed rather than pattern-matched loosely, so a crafted name cannot
 * smuggle a different id past the check.
 */
/**
 * `\\.\pipe\<prefix>-<uuidv4>-<nonce>`, anchored at both ends.
 *
 * A `split("-")` was tried first and is wrong: the separator appears *inside* the uuidv4, so
 * splitting on it shreds the id into fragments. Matching the whole shape is also what stops
 * a crafted name from carrying a valid id in the right position and something else
 * elsewhere.
 */
const PIPE_ENDPOINT_PATTERN =
	/^\\\\\.\\pipe\\[A-Za-z0-9._-]+-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[0-9a-f]{12,32}$/;

const DISCOVERY_PROBE_TIMEOUT_MS = 1_000;

/**
 * Decide whether a registered endpoint is a usable server.
 *
 * **The registry nominates; this authenticates.** A full `Client` connects and completes the
 * `hello` handshake, so the entry's credential is verified by the same constant-time check the
 * ordinary request path uses. Only a completed handshake makes the endpoint a route.
 *
 * Consequences, which are the point:
 *
 * - a registry entry naming a pipe no reachable server answers on is omitted;
 * - a registry entry naming an impostor's pipe is omitted, because the impostor cannot
 *   present the credential;
 * - a registry entry naming the *right* server is usable, which is the capability that was
 *   missing.
 *
 * Any failure is `false`. A probe that throws is not evidence of death — `discoverEndpoints`
 * treats a thrown probe as "leave the entry alone" — so this only reports positive results
 * and lets the caller's own error handling distinguish the cases.
 */
async function probeRegisteredEndpoint(entry: EndpointRegistryEntry, authToken: string | undefined): Promise<boolean> {
	if (authToken === undefined || authToken.length === 0) return false;
	const client = new Client({
		serverId: entry.serverId,
		authToken,
		transportFactory: createLocalTransportFactory({ transport: "named-pipe", path: entry.endpoint }, authToken),
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.connect(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("Endpoint probe timed out")), DISCOVERY_PROBE_TIMEOUT_MS);
				timeout.unref();
			}),
		]);
		return true;
	} catch {
		// Missing pipe, refused connection, wrong credential, protocol mismatch, timeout —
		// all mean "not a usable server", which is the only answer this returns.
		return false;
	} finally {
		if (timeout) clearTimeout(timeout);
		await client.dispose().catch(() => undefined);
	}
}

function routeFromExplicitPath(path: string): UnixServerRoute {
	const pipeMatch = PIPE_ENDPOINT_PATTERN.exec(path);
	if (pipeMatch) {
		const serverId = pipeMatch[1]!;
		if (!isServerId(serverId)) {
			throw new Error(`--connect pipe name must contain a uuidv4 server id, got ${JSON.stringify(serverId)}`);
		}
		return { serverId, path };
	}
	const name = basename(path);
	const serverId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
	if (!isServerId(serverId)) throw new Error("--connect path must end with <uuidv4-server-id>.sock");
	return { serverId, path };
}
