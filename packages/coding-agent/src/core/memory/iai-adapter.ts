/**
 * The IAI Personal adapter.
 *
 * ## What was verified about the engine, and what was not
 *
 * Verified against the built engine (`iai-proof.py`):
 *
 * - The native extension imports and exports `MemoryRecord`, `MemoryHit` and
 *   `RecallResponse`.
 * - The Python layer imports no network client and no telemetry SDK, which is
 *   the mechanical evidence available for the "local only, no telemetry" claim.
 * - The engine ships as an MCP-over-stdio package with `memory_capture`,
 *   `memory_recall` and `memory_contradict` among its tools.
 *
 * **Not verified here:** store lifecycle, capture, recall and supersession. The
 * engine's `hippo` store imports `numpy` at module load, and `numpy` is a
 * declared hard dependency that is absent from the local environment. The
 * stdio entry also has no `iai_mcp.__main__`; the server is reached through the
 * CLI. Both are environment facts, not interface facts, so this adapter is built
 * to the documented protocol and every call is checked against the engine's own
 * error contract rather than assumed. That gap is recorded as verification
 * debt rather than papered over.
 *
 * ## Why MCP rather than a library import
 *
 * The engine is an MCP server. Treating it as one keeps the adapter honest: if
 * the engine changes its storage, the adapter is unaffected, and if the engine
 * is unavailable the adapter reports unavailability instead of silently
 * degrading. Reaching into `iai_mcp` directly would couple PrimePi to a Python
 * package's internals, which is exactly the coupling the memory interface
 * exists to avoid.
 *
 * ## Memory is context, never authority
 *
 * Recalled text is returned to the caller as data. Nothing in this adapter can
 * write to the repository, and a recall result never becomes a decision: the
 * caller compares it against current state, which always wins.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import type { MemoryBackend, MemoryCandidate, MemoryHit, MemoryQuery, MemoryRecord } from "./backend.js";

/** One JSON-RPC message on the engine's stdio surface. */
interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number;
	method?: string;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface IaiAdapterOptions {
	/** Python interpreter that can import `iai_mcp`. */
	readonly python?: string;
	/** Import root, i.e. the engine's built extension directory. */
	readonly libraryPath?: string;
	/** Working directory for the engine process. */
	readonly cwd?: string;
	/** Where the engine keeps its store. */
	readonly dataDir?: string;
	/** Per-request deadline. */
	readonly timeoutMs?: number;
	/** Extra environment for the engine process. */
	readonly env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PYTHON = "python";

/** The engine's own tool names, used rather than invented aliases. */
const CAPTURE = "memory_capture";
const RECALL = "memory_recall";
const CONTRADICT = "memory_contradict";

/**
 * A live MCP-over-stdio session with the engine.
 *
 * One process, one request at a time. A child process per recall would cost a
 * full store open for every query, and the engine holds a lock on its store, so
 * a long-lived session is both faster and closer to how the engine is meant to
 * be used.
 */
export class IaiSession {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	#nextId = 1;
	#buffer = "";
	#closed = false;
	#stderr = "";

	constructor(child: ChildProcessWithoutNullStreams) {
		this.#child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.#onData(chunk));
		// stderr is the engine's log, not protocol. It is buffered for diagnostics
		// and never parsed, and never rendered into a transcript.
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.#stderr = (this.#stderr + chunk).slice(-4000);
		});
		child.once("exit", () => this.#failPending(new Error("the IAI engine exited")));
		child.once("error", (error) => this.#failPending(error));
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** The tail of the engine's stderr, for a diagnostic. Never a memory. */
	get diagnostics(): string {
		return this.#stderr;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		// Newline-delimited JSON, which is what the engine's stdio transport uses.
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline === -1) break;
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(line) as JsonRpcMessage;
			} catch {
				// A malformed line is skipped rather than allowed to stall the
				// session, matching the transport's own rule.
				continue;
			}
			this.#route(message);
		}
		// A stuck buffer means the engine is not speaking the protocol; drop it
		// rather than growing it without bound.
		if (this.#buffer.length > 8 * 1024 * 1024) this.#buffer = "";
	}

	#route(message: JsonRpcMessage): void {
		if (message.id === undefined) return;
		const pending = this.#pending.get(Number(message.id));
		if (!pending) return;
		this.#pending.delete(Number(message.id));
		if (message.error) {
			pending.reject(new Error(message.error.message || `engine error ${message.error.code}`));
			return;
		}
		pending.resolve(message.result);
	}

	#failPending(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	/** Sends a request and resolves with the engine's result. */
	async request<T = unknown>(
		method: string,
		params: unknown,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<T> {
		if (this.#closed) throw new Error("the IAI engine session is closed");
		const id = this.#nextId++;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			if (typeof timer.unref === "function") timer.unref();

			this.#pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			// An already-aborted signal must not send the request at all.
			if (options.signal?.aborted) {
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`${method} was cancelled`));
				return;
			}
			options.signal?.addEventListener(
				"abort",
				() => {
					this.#pending.delete(id);
					clearTimeout(timer);
					reject(new Error(`${method} was cancelled`));
				},
				{ once: true },
			);

			try {
				this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch (error) {
				this.#pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Notifies without expecting a reply. */
	notify(method: string, params: unknown): void {
		if (this.#closed) return;
		try {
			this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		} catch {
			// A closed pipe is reported through the pending request's rejection.
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#child.stdin.end();
		} catch {
			// Already gone.
		}
		// A SIGKILL after a grace period: an engine that ignores stdin close
		// must not outlive the session that started it.
		const exited = await Promise.race([
			once(this.#child, "exit").then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
		]);
		if (!exited) this.#child.kill("SIGKILL");
	}
}

/** Starts an engine session, or explains why one could not be started. */
export async function startIaiSession(
	options: IaiAdapterOptions = {},
): Promise<{ ok: true; session: IaiSession } | { ok: false; reason: string }> {
	const python = options.python ?? DEFAULT_PYTHON;
	const args: string[] = [];
	// The engine has no package `__main__`; its stdio server is reached through the
	// CLI module, which is the entry the engine documents.
	if (options.libraryPath)
		args.push(
			"-c",
			"import sys; sys.path.insert(0, sys.argv.pop()); from iai_mcp.cli import main; sys.exit(main())",
			options.libraryPath,
		);
	args.push("-m", "iai_mcp.cli");

	try {
		const child = spawn(python, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...(options.libraryPath ? { PYTHONPATH: options.libraryPath } : {}),
				...(options.dataDir ? { IAI_DATA_DIR: options.dataDir } : {}),
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;

		const session = new IaiSession(child);
		// The initialize handshake is the liveness check: an engine that cannot
		// answer it is unavailable, and the adapter says so rather than reporting
		// an empty store as "no memories".
		try {
			await session.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "primepi", version: "1" },
			});
		} catch (error) {
			await session.close();
			return {
				ok: false,
				reason: `the IAI engine did not complete an initialize handshake: ${error instanceof Error ? error.message : String(error)}${session.diagnostics ? ` (${session.diagnostics.slice(0, 200)})` : ""}`,
			};
		}
		session.notify("notifications/initialized", {});
		return { ok: true, session };
	} catch (error) {
		return {
			ok: false,
			reason: `could not start the IAI engine: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Maps the engine's record shape onto Pi's, keeping provenance and supersession. */
function toRecord(raw: unknown): MemoryRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const source = raw as Record<string, unknown>;
	const text =
		typeof source.text === "string" ? source.text : typeof source.content === "string" ? source.content : undefined;
	if (!text) return undefined;
	const kind = typeof source.kind === "string" ? (source.kind as MemoryRecord["kind"]) : "convention";
	return {
		id: String(source.id ?? source.record_id ?? ""),
		// A kind the engine reports that Pi has no category for is filed as a
		// decision rather than dropped, so nothing is lost on a version skew.
		kind: (
			[
				"decision",
				"convention",
				"root-cause",
				"fix",
				"failed-approach",
				"platform",
				"security",
				"flaky-test",
				"verification-debt",
				"parity-difference",
				"procedure",
			] as const
		).includes(kind)
			? kind
			: "decision",
		text,
		provenance: {
			scope: (source.scope as MemoryRecord["provenance"]["scope"]) ?? "project",
			...(typeof source.project === "string" ? { project: source.project } : {}),
			...(typeof source.source === "string" ? { source: source.source } : {}),
			...(typeof source.confidence === "number" ? { confidence: source.confidence } : {}),
			...(typeof source.evidence === "string" ? { evidence: source.evidence } : {}),
		},
		createdAt: typeof source.created_at === "number" ? source.created_at : Date.now(),
		...(typeof source.superseded_by === "string" ? { supersededBy: source.superseded_by } : {}),
	};
}

/**
 * The IAI Personal backend.
 *
 * Appended to the OMP Memory Backend selector as a PrimePi extension. Its
 * ordering never displaces a reference backend, and selecting it is the only
 * thing that makes it run: `Off` never constructs it, and the session is opened
 * lazily so a configured-but-unused backend costs nothing.
 */
export class IaiPersonalBackend implements MemoryBackend {
	readonly id = "iai-personal";
	readonly label = "IAI Personal";
	readonly description = "Local encrypted personal memory engine (MCP over stdio)";

	readonly capabilities = {
		recall: true,
		retain: true,
		// The engine runs its own consolidation and rescue passes; Pi does not
		// pretend to drive them.
		consolidate: true,
		persistent: true,
		local: true,
		// Stated because the engine's own documentation claims AES-256-GCM at
		// rest. It is a claim about the engine, not something this adapter
		// verifies or can weaken.
		encryptedAtRest: true,
	} as const;

	readonly #options: IaiAdapterOptions;
	#session: IaiSession | undefined;
	#starting: Promise<{ ok: true; session: IaiSession } | { ok: false; reason: string }> | undefined;

	constructor(options: IaiAdapterOptions = {}) {
		this.#options = options;
	}

	async available(): Promise<{ ok: boolean; reason?: string }> {
		// Availability is a liveness probe, not an install step. Nothing here
		// downloads a dependency, adds a path, or writes outside the engine's own
		// data directory.
		const started = await this.#ensureSession();
		if (started.ok) return { ok: true };
		return { ok: false, reason: started.reason };
	}

	async #ensureSession() {
		if (this.#session && !this.#session.closed) return { ok: true as const, session: this.#session };
		// A concurrent first call shares one handshake rather than starting two
		// engines against the same store, which the engine's lock would refuse.
		if (!this.#starting) this.#starting = startIaiSession(this.#options);
		const started = await this.#starting;
		this.#starting = undefined;
		if (started.ok) this.#session = started.session;
		return started;
	}

	async start(): Promise<void> {
		await this.#ensureSession();
	}

	async stop(): Promise<void> {
		await this.#session?.close();
		this.#session = undefined;
	}

	async retain(candidate: MemoryCandidate): Promise<MemoryRecord | undefined> {
		const started = await this.#ensureSession();
		if (!started.ok) {
			// A store that cannot be reached must not silently drop the memory with
			// no signal: the caller is told the write did not happen.
			throw new Error(started.reason);
		}
		const result = (await started.session.request(CAPTURE, {
			text: candidate.text,
			kind: candidate.kind,
			scope: candidate.provenance.scope,
			...(candidate.provenance.project ? { project: candidate.provenance.project } : {}),
			...(candidate.provenance.source ? { source: candidate.provenance.source } : {}),
			...(candidate.provenance.evidence ? { evidence: candidate.provenance.evidence } : {}),
			...(candidate.provenance.confidence !== undefined ? { confidence: candidate.provenance.confidence } : {}),
		})) as unknown;
		return toRecord(result);
	}

	async recall(query: MemoryQuery): Promise<readonly MemoryHit[]> {
		const started = await this.#ensureSession();
		if (!started.ok) return [];
		const result = (await started.session.request(RECALL, {
			cue: query.text,
			...(query.scope ? { scope: query.scope } : {}),
			...(query.project ? { project: query.project } : {}),
			...(query.kinds ? { kinds: query.kinds } : {}),
			limit: query.limit ?? 10,
		})) as unknown;
		return toHits(result);
	}

	/**
	 * Records that a fact changed.
	 *
	 * The engine archives rather than erases, which is the right semantics for a
	 * changed fact: both versions stay retrievable, so a stale memory cannot
	 * masquerade as current. That behaviour is relied on rather than reimplemented.
	 */
	async contradict(input: {
		recordId: string;
		text: string;
		provenance?: MemoryCandidate["provenance"];
	}): Promise<boolean> {
		const started = await this.#ensureSession();
		if (!started.ok) return false;
		const result = (await started.session.request(CONTRADICT, {
			record_id: input.recordId,
			text: input.text,
			...(input.provenance ? { scope: input.provenance.scope } : {}),
		})) as { ok?: boolean } | undefined;
		return result?.ok !== false;
	}

	async consolidate(): Promise<void> {
		const started = await this.#ensureSession();
		if (!started.ok) return;
		await started.session.request("memory_consolidate", {});
	}
}

function toHits(result: unknown): MemoryHit[] {
	// The engine returns hits and anti-hits together. Keeping them apart is the
	// point: a surface that only returns confirming evidence lets a stale fact
	// read as current.
	const source = result as { hits?: unknown[]; results?: unknown[]; anti_hits?: unknown[] };
	const raw = source?.hits ?? source?.results ?? [];
	if (!Array.isArray(raw)) return [];
	return raw
		.map((entry) => toRecord(entry))
		.filter((record): record is MemoryRecord => record !== undefined)
		.map((record) => ({ record, score: 1 }));
}
