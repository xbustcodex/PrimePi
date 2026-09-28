/**
 * The LSP transport: framing, correlation and lifecycle.
 *
 * ## Why this layer owns the protocol
 *
 * Everything above it — document sync, diagnostics, the agent-facing
 * operations — assumes two things this module guarantees and nothing else does:
 * that a byte stream is cut into whole JSON-RPC messages, and that every
 * response is routed to the request waiting for it. Both are easy to get subtly
 * wrong and impossible to debug from above, so they live here alone.
 *
 * ## The three framing cases
 *
 * A conforming server writes `Content-Length: N\r\n\r\n<N bytes>`. A stream
 * delivers those bytes in whatever sizes it likes, so three cases must be
 * handled and each has bitten a real implementation:
 *
 * - **A frame split across chunks.** The buffer must accumulate until a whole
 *   frame is present. Splitting on chunk boundaries and losing the tail is the
 *   classic LSP bug.
 * - **Several frames in one chunk.** Draining must be a loop, not a single
 *   read, or the second message waits in the buffer until the next one arrives —
 *   which presents as a server that went quiet.
 * - **Content-Length counts bytes, not characters.** A message containing any
 *   non-ASCII is shorter in characters than in bytes, so slicing by
 *   `String.length` desynchronises the stream permanently. The buffer is
 *   therefore held as bytes throughout and sliced with `Buffer.subarray`.
 *
 * ## The id-collision rule
 *
 * **A message carrying `method` is server-originated; a message without one is
 * a response.** The order matters and the two are not interchangeable. A
 * server's request ids live in its own id space and routinely collide with
 * ours: a `workspace/configuration` pull can arrive while a `documentSymbol`
 * request with the same id is in flight. Matching pending requests first would
 * swallow the pull as a bogus response, drop the configuration the server is
 * blocked waiting for, and resolve our own request with `undefined` — wedging
 * the handshake. OMP found this in production (its comment cites issue #3001)
 * and this module follows its fix.
 *
 * ## What this module will not do
 *
 * It will not parse LSP payloads, interpret positions, or know what a diagnostic
 * is. It moves bytes and correlates ids. A language server is an untrusted
 * external process: its stdout is parsed defensively, a malformed message is
 * skipped rather than allowed to kill the reader, and a server that dies takes
 * down only its own client.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** A decoded JSON-RPC message. Shape is checked by the router. */
export type JsonRpcMessage = Record<string, unknown> & { jsonrpc?: string };

/** Cap on a single message, so a broken server cannot exhaust memory. */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Cap on buffered-but-unparsed bytes, so a stream of garbage cannot grow forever. */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Answers a server-initiated request. */
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

/** Called for each server notification. */
export type NotificationHandler = (method: string, params: unknown) => void;

/** Construction options, shared by every transport. */
export interface LspTransportOptions {
	readonly maxMessageBytes?: number;
	readonly maxBufferBytes?: number;
	readonly onServerRequest?: ServerRequestHandler;
	readonly onNotification?: NotificationHandler;
	readonly onClose?: (reason: string) => void;
}

/** Finds the blank line ending a header block, and the body start after it. */
function findHeaderEnd(buffer: Buffer): { headerEnd: number; bodyStart: number } | -1 {
	// The separator is \r\n\r\n per spec. \n\n is accepted too: a server emitting
	// only \n is common enough that refusing it would break a real setup for no
	// safety gain.
	for (const pattern of ["\r\n\r\n", "\n\n"]) {
		const index = buffer.indexOf(pattern, 0, "utf8");
		if (index !== -1) return { headerEnd: index, bodyStart: index + pattern.length };
	}
	return -1;
}

/** Reads Content-Length from a header block, case-insensitively as the spec requires. */
function parseContentLength(header: string): number | undefined {
	for (const line of header.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		const value = Number(line.slice(separator + 1).trim());
		return Number.isFinite(value) ? Math.trunc(value) : undefined;
	}
	return undefined;
}

/**
 * Splits a byte stream into JSON-RPC message bodies.
 *
 * Byte-oriented throughout, for the Content-Length reason above. A `drain`
 * returns everything currently complete, so several frames delivered in one
 * chunk are all yielded.
 */
export class MessageFramer {
	#buffer: Buffer;
	readonly #maxMessageBytes: number;
	readonly #maxBufferBytes: number;

	constructor(initial?: Buffer, options: { maxMessageBytes?: number; maxBufferBytes?: number } = {}) {
		this.#buffer = initial ?? Buffer.alloc(0);
		this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
	}

	/** Appends freshly read bytes. */
	push(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
	}

	/** Bytes currently held, for diagnostics and for the buffer cap. */
	get buffered(): number {
		return this.#buffer.length;
	}

	/**
	 * Removes and returns every complete message body currently buffered.
	 *
	 * `onResync` fires for a header block with no Content-Length — what a wrapper
	 * script printing to stdout produces. The alternative is stalling on the same
	 * junk header forever, which presents as a server that is alive and answers
	 * nothing.
	 */
	drain(onResync?: (headerText: string) => void): string[] {
		const messages: string[] = [];
		for (;;) {
			const separator = findHeaderEnd(this.#buffer);
			if (separator === -1) break;
			const header = this.#buffer.subarray(0, separator.headerEnd).toString("utf8");
			const length = parseContentLength(header);
			if (length === undefined || length < 0 || length > this.#maxMessageBytes) {
				if (length === undefined) onResync?.(header);
				// Drop the junk header and rescan from just after it. The loop always
				// makes progress, because the buffer shrank.
				this.#buffer = this.#buffer.subarray(separator.bodyStart);
				continue;
			}
			const end = separator.bodyStart + length;
			if (this.#buffer.length < end) break;
			messages.push(this.#buffer.subarray(separator.bodyStart, end).toString("utf8"));
			this.#buffer = this.#buffer.subarray(end);
		}
		this.#enforceBufferCap();
		return messages;
	}

	#enforceBufferCap(): void {
		if (this.#buffer.length <= this.#maxBufferBytes) return;
		// Nothing parseable is buffered and the buffer is over cap, so the stream is
		// not protocol. Dropping it lets a later well-framed message through
		// instead of wedging the client on garbage.
		this.#buffer = Buffer.alloc(0);
	}
}

/** One framed request awaiting its response. */
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	method: string;
}

/** The transport surface. Implementations own a process or a socket. */
export class LspTransport {
	readonly #name: string;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #framer: MessageFramer;
	#nextId = 1;
	#closed = false;
	readonly #onServerRequest: ServerRequestHandler | undefined;
	readonly #onNotification: NotificationHandler | undefined;
	readonly #onClose: ((reason: string) => void) | undefined;

	constructor(name: string, options: LspTransportOptions = {}) {
		this.#name = name;
		this.#framer = new MessageFramer(undefined, options);
		this.#onServerRequest = options.onServerRequest;
		this.#onNotification = options.onNotification;
		this.#onClose = options.onClose;
	}

	get name(): string {
		return this.#name;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** In-flight request count, for diagnostics. */
	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Feeds received bytes through the framer and routes everything it yields. */
	receive(chunk: Buffer): void {
		if (this.#closed) return;
		this.#framer.push(chunk);
		for (const text of this.#framer.drain()) {
			let message: JsonRpcMessage;
			try {
				const parsed: unknown = JSON.parse(text);
				// A well-framed message that is not an object is malformed. Skipping it
				// keeps the reader alive; throwing would kill every later message.
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
				message = parsed as JsonRpcMessage;
			} catch {
				continue;
			}
			this.#route(message);
		}
	}

	#route(message: JsonRpcMessage): void {
		// Order is load-bearing: a message with `method` is server-originated, even
		// when its id collides with one of ours. See the module comment.
		if (typeof message.method === "string") {
			if (message.id !== undefined && message.id !== null) {
				void this.#answerServerRequest(message);
			} else {
				this.#onNotification?.(message.method, message.params);
			}
			return;
		}
		if (message.id === undefined || message.id === null) return;
		const pending = this.#pending.get(Number(message.id));
		if (!pending) return;
		this.#pending.delete(Number(message.id));
		if (pending.timer) clearTimeout(pending.timer);
		const error = message.error;
		if (error !== undefined && error !== null) {
			const detail = error as { message?: string };
			pending.reject(new Error(`${pending.method} failed: ${detail.message ?? "unknown error"}`));
			return;
		}
		pending.resolve(message.result);
	}

	async #answerServerRequest(message: JsonRpcMessage): Promise<void> {
		const id = message.id;
		const method = message.method as string;
		if (!this.#onServerRequest) {
			// Declining beats silence: a server blocked on an unanswered request
			// stalls its own handshake, and we cannot answer it correctly.
			this.sendRaw({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not supported` } });
			return;
		}
		try {
			const result = await this.#onServerRequest(method, message.params);
			this.sendRaw({ jsonrpc: "2.0", id, result: result ?? null });
		} catch (thrown) {
			// A throwing handler must not kill the reader; the server gets an error
			// response and later messages still flow.
			this.sendRaw({
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message: thrown instanceof Error ? thrown.message : "handler failed" },
			});
		}
	}

	/** Sends a request and resolves with its result. */
	request<T = unknown>(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<T> {
		if (this.#closed) return Promise.reject(new Error(`${this.#name} transport is closed`));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer =
				options.timeoutMs && options.timeoutMs > 0
					? setTimeout(() => {
							this.#pending.delete(id);
							reject(new Error(`${method} timed out after ${options.timeoutMs}ms`));
						}, options.timeoutMs)
					: undefined;
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });

			if (options.signal) {
				if (options.signal.aborted) {
					this.#settle(id, new Error(`${method} was aborted`), timer);
					return;
				}
				options.signal.addEventListener(
					"abort",
					() => this.#settle(id, new Error(`${method} was aborted`), timer),
					{
						once: true,
					},
				);
			}
			this.sendRaw({ jsonrpc: "2.0", id, method, params });
		});
	}

	#settle(id: number, error: Error, timer: ReturnType<typeof setTimeout> | undefined): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (timer) clearTimeout(timer);
		pending.reject(error);
	}

	/** Sends a notification, which has no response. */
	notify(method: string, params: unknown): void {
		if (this.#closed) return;
		this.sendRaw({ jsonrpc: "2.0", method, params });
	}

	/**
	 * Writes a message. Abstract so a test needs no process, and so a socket
	 * transport shares everything above this line.
	 */
	protected sendRaw(_message: JsonRpcMessage): void {
		// Implemented by the concrete transport.
	}

	/**
	 * Marks the transport closed and fails everything still waiting.
	 *
	 * A server that dies must not leave callers hanging: an unresolved promise is
	 * a leaked future, and a session waiting on it waits forever.
	 */
	close(reason = "closed"): void {
		if (this.#closed) return;
		this.#closed = true;
		const error = new Error(`${this.#name} transport closed: ${reason}`);
		for (const [id, pending] of [...this.#pending]) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
			this.#pending.delete(id);
		}
		this.#onClose?.(reason);
	}
}

/** A transport over a child process's stdio. */
export class StdioTransport extends LspTransport {
	readonly #child: ChildProcessWithoutNullStreams;

	constructor(name: string, child: ChildProcessWithoutNullStreams, options: LspTransportOptions = {}) {
		super(name, options);
		this.#child = child;
		child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
		// A server writing to stderr is normal; it is not our stream and must not
		// be parsed as protocol.
		child.stderr?.resume();
		const fail = (event: "exit" | "error") => () => {
			const code = (child as unknown as { exitCode?: number | null }).exitCode;
			this.close(`${event}${code === undefined || code === null ? "" : ` (code ${code})`}`);
		};
		child.once("exit", fail("exit"));
		child.once("error", fail("error"));
	}

	protected override sendRaw(message: JsonRpcMessage): void {
		const body = JSON.stringify(message);
		// Content-Length is a byte count. `Buffer.byteLength` on a string containing
		// non-ASCII is what keeps the frame parseable; using `body.length`
		// desynchronises the server's reader permanently.
		const length = Buffer.byteLength(body, "utf8");
		this.#child.stdin.write(`Content-Length: ${length}\r\n\r\n${body}`);
	}

	get process(): ChildProcessWithoutNullStreams {
		return this.#child;
	}
}

/** A transport driven by explicit writes, for tests and for an in-memory server. */
export class TestTransport extends LspTransport {
	readonly #sent: JsonRpcMessage[] = [];
	/** Set to throw on the next `sendRaw`, to exercise a broken pipe. */
	sendFailure: Error | undefined;

	protected override sendRaw(message: JsonRpcMessage): void {
		if (this.sendFailure) {
			const failure = this.sendFailure;
			this.sendFailure = undefined;
			throw failure;
		}
		this.#sent.push(message);
	}

	/** Everything written so far. */
	get sent(): readonly JsonRpcMessage[] {
		return this.#sent;
	}

	/**
	 * Answers requests by method, for a scripted server.
	 *
	 * The responder runs instead of a real process, so an operations test can
	 * assert on result handling — every shape the protocol permits — without a
	 * language server being installed.
	 */
	set responder(fn: (method: string, params: unknown) => unknown) {
		this.#responder = fn;
	}

	get responder(): ((method: string, params: unknown) => unknown) | undefined {
		return this.#responder;
	}

	#responder: ((method: string, params: unknown) => unknown) | undefined;

	/** Delivers a server-originated message. */
	deliver(message: JsonRpcMessage): void {
		this.receive(Buffer.from(JSON.stringify(message), "utf8"));
	}

	/**
	 * Delivers a scripted response for the request the client last issued.
	 *
	 * The scripted path is a whole request/response exchange driven from the test,
	 * which is what lets result handling be exercised without a server installed.
	 */
	async answerNext(method: string, params: unknown): Promise<void> {
		const issued = this.#sent.find(
			(message) => message.method === method && typeof message.id === "number" && !this.#answered.has(message.id),
		);
		if (!issued) throw new Error(`TestTransport: no pending request for ${method}`);
		const id = issued.id as number;
		this.#answered.add(id);
		void params;
		this.deliverFramed({ jsonrpc: "2.0", id, result: this.responder?.(method, params) ?? null });
	}

	readonly #answered = new Set<number>();

	/** Delivers raw bytes, for framing tests. */
	deliverRaw(chunk: Buffer | string): void {
		this.receive(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
	}

	/** Frames and delivers a body the way a server would. */
	deliverFramed(body: unknown): void {
		const text = JSON.stringify(body);
		const length = Buffer.byteLength(text, "utf8");
		this.receive(Buffer.from(`Content-Length: ${length}\r\n\r\n${text}`, "utf8"));
	}
}
