import { createConnection, type Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH, ProtocolValidationError } from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

const DEFAULT_MAX_PENDING_BYTES_FACTOR = 4;

/**
 * The only path shape `net` treats as a named pipe.
 *
 * Rejecting anything else is what keeps this transport from becoming a loopback TCP
 * endpoint by configuration: `net.connect({ path: "host:port" })` would open a socket.
 */
const PIPE_PATH_PREFIX = /^\\\\\.\\pipe\\/;

export interface WindowsNamedPipeTransportOptions {
	/** Full pipe name, including the `\\.\pipe\` prefix. */
	path: string;
	maxPendingBytes?: number;
}

/**
 * Create a transport factory for Windows named pipes.
 *
 * ## What this deliberately does not provide
 *
 * No ACL. `node:net` cannot set a named pipe's security descriptor, so a pipe created by
 * the server is reachable by any local process that can name it. The security property
 * "only the intended peer connects" is therefore established one layer up, by the
 * credential the server requires in its `hello` frame — see `ServerOptions.authToken`.
 *
 * This is the same posture current OMP takes: `node:net` bound to
 * `\\.\pipe\omp-collab-<id>` with a per-request `timingSafeEqual` bearer
 * (`collab/registry.ts:449-453`, `launch/broker.ts:546`).
 *
 * The POSIX transport is unchanged and keeps its `0600` socket inside a `0700`
 * directory. Unix was not weakened to make the two symmetrical; the credential is simply
 * unused there.
 */
export function createWindowsNamedPipeTransportFactory(
	options: WindowsNamedPipeTransportOptions,
): ByteTransportFactory {
	const maxPendingBytes = validateOptions(options);
	return (handlers) => connectPipe(options.path, maxPendingBytes, handlers);
}

function validateOptions(options: WindowsNamedPipeTransportOptions): number {
	if (options.path.length === 0) throw new TypeError("Windows named-pipe transport path must not be empty");
	if (!PIPE_PATH_PREFIX.test(options.path)) {
		throw new TypeError(
			`Windows named-pipe transport path must begin with ${PIPE_PATH_PREFIX.source}; refusing ${JSON.stringify(options.path)}`,
		);
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * DEFAULT_MAX_PENDING_BYTES_FACTOR;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("Windows named-pipe transport maxPendingBytes must be a positive safe integer");
	}
	return maxPendingBytes;
}

function connectPipe(path: string, maxPendingBytes: number, handlers: ByteTransportHandlers): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = createConnection({ path });
		let connected = false;
		let terminal = false;

		const close = (): void => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onClose();
			else reject(new Error("Windows named-pipe transport closed before connecting"));
		};

		socket.once("connect", () => {
			if (terminal) return;
			connected = true;
			resolve(
				new WindowsNamedPipeByteTransport(socket, maxPendingBytes, () => {
					terminal = true;
				}),
			);
		});
		socket.on("data", (chunk) => {
			if (!terminal) handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.once("end", close);
		socket.once("close", close);
		socket.once("error", (error) => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onError(error);
			else reject(error);
		});
	});
}

class WindowsNamedPipeByteTransport implements ByteTransport {
	readonly #socket: Socket;
	readonly #maxPendingBytes: number;
	#closed = false;

	readonly #markTerminal: () => void;

	constructor(socket: Socket, maxPendingBytes: number, markTerminal: () => void) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markTerminal = markTerminal;
	}

	get closed(): boolean {
		return this.#closed;
	}

	async send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) throw new ProtocolValidationError("Windows named-pipe transport is closed");
		if (chunk.byteLength > this.#maxPendingBytes) {
			throw new ProtocolValidationError(
				`Windows named-pipe transport send of ${chunk.byteLength} bytes exceeds maxPendingBytes ${this.#maxPendingBytes}`,
			);
		}
		await new Promise<void>((resolve, reject) => {
			this.#socket.write(chunk, (error) => (error ? reject(error) : resolve()));
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markTerminal();
		this.#socket.destroy();
	}
}
