import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { ServerListener } from "../../listener.ts";
import type { WindowsNamedPipeListenerOptions } from "./types.ts";

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * The only path shape `net` treats as a named pipe.
 *
 * Enforced in `resolveWindowsNamedPipeListenerOptions`. A path outside this shape would
 * be interpreted as something else entirely — on POSIX as a filesystem path, and on
 * Windows as an implicit loopback TCP endpoint — so rejecting it here is what makes
 * "never accidentally network-accessible" a checked invariant rather than an assumption.
 */
const PIPE_PATH_PREFIX = /^\\\\\.\\pipe\\/;

/**
 * The Windows named-pipe listener.
 *
 * ## Why this exists, and what it deliberately does not do
 *
 * The POSIX listener's security comes from the operating system: a `0700` directory and
 * a `0600` socket mean only the owner can reach the endpoint. `node:net` cannot set a
 * named pipe's security descriptor, so a pipe inherits a default DACL that is **not**
 * owner-only. Two consequences shape everything below.
 *
 * **The pipe name is not a security boundary, so it is treated as public input.** A
 * different local process can create a pipe with the name we expect before we bind. Two
 * things therefore matter:
 *
 * 1. *Binding* is atomic and exclusive. `net.Server.listen` on a pipe name fails with
 *    `EADDRINUSE` if any server already holds that name, which is the same guarantee the
 *    POSIX listener gets from `link()` failing `EEXIST`. A squatter cannot silently steal
 *    the endpoint from a running server, and two servers cannot both believe they own it.
 * 2. *Reaching* the endpoint proves nothing. A client that finds a pipe name in a
 *    directory scan may have found an impostor, so discovery only ever reports a route
 *    after the connection has completed an authenticated handshake, and the credential is
 *    compared in constant time inside the `hello` gate.
 *
 * This is the posture current OMP uses for the same problem: `node:net` bound to
 * `\\.\pipe\omp-collab-<entryId>` with a `timingSafeEqual` bearer
 * (`packages/coding-agent/src/collab/registry.ts:449-453, 207-211`), and the same again
 * for the daemon broker (`launch/paths.ts:49-55`, `launch/broker.ts:546`).
 *
 * ## What this listener does not claim
 *
 * It does not provide an owner-only ACL. "Only the intended peer may connect" is supplied
 * by the credential, not by the transport, and a local process that can *observe* both the
 * pipe name and the credential could still connect. Closing that gap properly means a
 * native pipe DACL, which `node:net` does not expose. Unix is not weakened to make the
 * two platforms symmetrical: the POSIX path keeps its filesystem permissions, and the
 * credential is simply unused there.
 *
 * ## Properties, mapped to mechanisms
 *
 * | Property | Mechanism here |
 * |---|---|
 * | only the intended peer connects | credential in `hello`, constant-time compared |
 * | endpoint cannot be impersonated | `EADDRINUSE` on bind is atomic and exclusive |
 * | stale endpoint cannot attract a client | no filesystem residue; a dead pipe stops existing |
 * | identity not from the pathname | credential is proved in-band after connecting |
 * | cleanup touches only our own endpoint | we only ever close the net server we created |
 * | reconnect cannot cross an identity | every reconnect re-runs the `hello` gate |
 * | not network-accessible | `\\.\pipe\` has no host and no port |
 * | failure closed, explicit, diagnosable | every refusal throws a named error |
 */
class WindowsNamedPipeListener implements ServerListener {
	private readonly options: Required<Omit<WindowsNamedPipeListenerOptions, "onError">> & {
		onError?: (error: Error) => void;
	};
	private readonly connections = new Set<ByteConnection>();
	private server?: Server;
	private accept?: ByteConnectionAcceptor;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(options: WindowsNamedPipeListenerOptions) {
		this.options = resolveWindowsNamedPipeListenerOptions(options);
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("Windows named-pipe listener is already started");
		if (this.closing) throw new Error("Windows named-pipe listener is closing or closed");
		this.accept = accept;

		const server = createServer((socket) => this.acceptSocket(socket));
		server.on("error", (error) => this.reportError(error));
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				// The kernel guarantees exclusive ownership of a pipe name: a second bind
				// fails EADDRINUSE rather than silently sharing it. That is the property the
				// POSIX listener gets from link() failing EEXIST.
				server.listen({ path: this.options.path });
			});
		} catch (error) {
			this.server = undefined;
			server.close();
			if (isErrorCode(error, "EADDRINUSE")) {
				throw new Error(
					`Windows named-pipe endpoint is already in use, refusing to share it: ${this.options.path}`,
				);
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private closeInternal(): Promise<void> {
		const results = [closeNetServer(this.server, (error) => this.reportError(error))];
		for (const connection of this.connections) {
			try {
				void connection.close();
			} catch (error) {
				this.reportError(error);
			}
		}
		this.connections.clear();
		this.server = undefined;
		return results.length === 1 ? (results[0] as Promise<void>) : Promise.all(results).then(() => {});
	}

	private acceptSocket(socket: Socket): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		const connection = new WindowsNamedPipeByteConnection(
			socket,
			this.options.gracefulCloseTimeoutMs,
			this.options.maxPendingBytes,
		);
		this.connections.add(connection);
		const accept = this.accept;
		if (!accept) {
			socket.destroy();
			return;
		}
		const handler = accept(connection);
		socket.on("data", (chunk) => {
			handler.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.on("error", (error) => {
			handler.onError(error);
			socket.destroy();
		});
		socket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			handler.onClose();
		});
	}

	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect listener state.
		}
	}
}

/** @internal Exported only for transport-level verification. */
export class WindowsNamedPipeByteConnection implements ByteConnection {
	readonly #socket: Socket;
	readonly #gracefulCloseTimeoutMs: number;
	readonly #maxPendingBytes: number;
	#closed = false;
	#pendingBytes = 0;
	#closePromise?: Promise<void>;

	constructor(socket: Socket, gracefulCloseTimeoutMs: number, maxPendingBytes: number) {
		this.#socket = socket;
		this.#gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
		this.#maxPendingBytes = maxPendingBytes;
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Windows named-pipe connection is closed"));
		return new Promise<void>((resolve, reject) => {
			this.#socket.write(chunk, (error) => (error ? reject(error) : resolve()));
		});
	}

	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = new Promise<void>((resolve) => {
			const finish = (): void => {
				this.markClosed();
				this.#socket.destroy();
				resolve();
			};
			if (finalChunk && !this.#closed) {
				this.#socket.end(finalChunk, finish);
				return;
			}
			this.#socket.end(finish);
			const timer = setTimeout(() => {
				this.#socket.destroy();
				resolve();
			}, this.#gracefulCloseTimeoutMs);
			timer.unref();
		});
		return this.#closePromise;
	}

	markClosed(): void {
		this.#closed = true;
		this.#pendingBytes = 0;
	}

	/** @internal Accounting used by the connection tests. */
	accountPendingBytes(bytes: number): void {
		this.#pendingBytes += bytes;
		if (this.#pendingBytes > this.#maxPendingBytes) {
			this.#socket.destroy(new Error(`Windows named-pipe peer exceeded ${this.#maxPendingBytes} pending bytes`));
		}
	}

	/** @internal Exported only so a test can build a unique, non-colliding pipe name. */
	static uniquePipeName(prefix = "pi"): string {
		return `\\\\.\\pipe\\${prefix}-${randomUUID()}`;
	}
}

function closeNetServer(server: Server | undefined, reportError: (error: Error) => void): Promise<void> {
	if (!server) return Promise.resolve();
	return new Promise<void>((resolve) => {
		server.close((error) => {
			if (error) reportError(error);
			resolve();
		});
	});
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export function createWindowsNamedPipeListener(options: WindowsNamedPipeListenerOptions): ServerListener {
	return new WindowsNamedPipeListener(options);
}

function resolveWindowsNamedPipeListenerOptions(
	options: WindowsNamedPipeListenerOptions,
): Required<Omit<WindowsNamedPipeListenerOptions, "onError">> & { onError?: (error: Error) => void } {
	if (options.path.length === 0) throw new TypeError("Windows named-pipe path must not be empty");
	if (!PIPE_PATH_PREFIX.test(options.path)) {
		throw new TypeError(
			`Windows named-pipe path must begin with ${PIPE_PATH_PREFIX.source}; refusing ${JSON.stringify(options.path)}`,
		);
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs < 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(
			`Windows named-pipe gracefulCloseTimeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`,
		);
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`Windows named-pipe maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("Windows named-pipe maxPendingBytes must be a positive safe integer");
	}
	return { path: options.path, gracefulCloseTimeoutMs, maxFrameLength, maxPendingBytes, onError: options.onError };
}
