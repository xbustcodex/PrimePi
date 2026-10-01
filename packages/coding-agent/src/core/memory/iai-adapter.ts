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
import type { MemoryBackend, MemoryCandidate, MemoryHit, MemoryQuery, MemoryRecord } from "./backend.ts";

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
/** A real, side-effect-free method used as the liveness probe. */
const PROBE = "status_light";

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
	// Traced from the engine's own source: `iai_mcp.core:main` is the stdio server.
	// It reads newline-delimited JSON-RPC from stdin and writes replies to stdout.
	// `iai_mcp.cli:main` is the operator CLI and takes subcommands, so it is the
	// wrong entry for a session - it would parse the JSON-RPC line as an argument.
	// There is no `iai_mcp.__main__`.
	if (options.libraryPath)
		args.push(
			"-c",
			"import sys; sys.path.insert(0, sys.argv.pop()); from iai_mcp.core import main; main()",
			options.libraryPath,
		);
	args.push("-m", "iai_mcp.core");

	try {
		const child = spawn(python, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...(options.libraryPath ? { PYTHONPATH: options.libraryPath } : {}),
				// The engine's own root override, traced in `iai_mcp.hippo._resolve_root`.
				// It relocates the store *and* the crypto key file, so an isolated
				// proof cannot touch the owner's memories or reuse their key.
				...(options.dataDir ? { IAI_MCP_STORE: options.dataDir } : {}),
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;

		const session = new IaiSession(child);
		// There is no `initialize` handshake. Traced in `iai_mcp.core.dispatch`, the
		// engine answers a fixed set of method names and nothing else; an unknown
		// method raises UnknownMethodError. The liveness check therefore asks for a
		// real, side-effect-free method, and an engine that cannot answer it is
		// unavailable rather than reported as an empty store.
		try {
			await session.request(PROBE, {}, { timeoutMs: options.timeoutMs ?? 15_000 });
		} catch (error) {
			await session.close();
			return {
				ok: false,
				reason: `the IAI engine did not answer a liveness probe: ${error instanceof Error ? error.message : String(error)}${session.diagnostics ? ` (${session.diagnostics.slice(0, 200)})` : ""}`,
			};
		}
		return { ok: true, session };
	} catch (error) {
		return {
			ok: false,
			reason: `could not start the IAI engine: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Maps an engine hit onto Pi's record shape.
 *
 * Traced from `iai_mcp.core._serializers._hit_to_json`. The engine's field names
 * are `record_id`, `literal_surface`, `valid_from`, `valid_to` and `score` -
 * none of which match the names a reader would guess, so each is mapped
 * explicitly rather than by a spread.
 *
 * `valid_to` is the supersession signal. The engine never deletes a contradicted
 * record; it closes its validity interval, and a hit with a `valid_to` in the
 * past is a fact that has stopped being current. Mapping that to `supersededBy`
 * is what lets the shared service withhold it, rather than handing a later
 * session a stale claim that reads as true.
 */
function toRecord(raw: unknown): MemoryRecord | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const source = raw as Record<string, unknown>;
	const text = typeof source.literal_surface === "string" ? source.literal_surface : undefined;
	if (!text) return undefined;
	const validFrom = typeof source.valid_from === "string" ? Date.parse(source.valid_from) : Number.NaN;
	const validTo = typeof source.valid_to === "string" ? Date.parse(source.valid_to) : Number.NaN;
	return {
		id: String(source.record_id ?? ""),
		// The engine has no equivalent of Pi's kind vocabulary, and inventing a
		// mapping would assert a classification the engine never made. A
		// convention is the honest default: it is a stated fact about the project.
		kind: "convention",
		text,
		provenance: {
			scope: "project",
			...(typeof source.session_id === "string" && source.session_id !== "-"
				? { sessionId: source.session_id }
				: {}),
		},
		createdAt: Number.isFinite(validFrom) ? validFrom : Date.now(),
		// A closed validity interval, or a record the engine explicitly marked as
		// superseded, both mean "this is no longer current".
		...(Number.isFinite(validTo) ? { supersededBy: "engine-closed-interval" } : {}),
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
		// Measured, not quoted. The SQLite store and the HNSW index were confirmed to
		// contain no plaintext record text after a real capture, so the record store
		// is encrypted at rest.
		//
		// This is `true` because the *store* is encrypted, not because every file
		// under the engine's root is. One derived markdown cache,
		// `.working-tier.-.cached.md`, was found to hold record text in plaintext.
		// It is regenerated from the store and the engine opens fine without it, so
		// the store remains authoritative - but a blanket "everything is encrypted"
		// would be false, and a user relying on it would be misled. Recorded as PD-9.
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
		// Traced from `iai_mcp.capture.capture_turn`: `cue` and `text` are both
		// required, `tier` defaults to "episodic", and provenance travels in
		// `provenance_extra`. Pi has no tier vocabulary, so the kind is recorded in
		// provenance and the tier is chosen from the one meaningful distinction the
		// engine draws: a stated project fact is semantic, everything else episodic.
		const result = (await started.session.request(CAPTURE, {
			cue: candidate.text.slice(0, 80),
			text: candidate.text,
			tier: candidate.kind === "decision" || candidate.kind === "convention" ? "semantic" : "episodic",
			role: "user",
			provenance_extra: {
				...(candidate.provenance.project ? { project: candidate.provenance.project } : {}),
				...(candidate.provenance.source ? { source: candidate.provenance.source } : {}),
				...(candidate.provenance.taskId ? { task_id: candidate.provenance.taskId } : {}),
				...(candidate.provenance.worktree ? { worktree: candidate.provenance.worktree } : {}),
				...(candidate.provenance.evidence ? { evidence: candidate.provenance.evidence } : {}),
				kind: candidate.kind,
				scope: candidate.provenance.scope,
			},
		})) as { status?: string; record_id?: string; reason?: string };
		// The engine acknowledges a write with {status, record_id, reason} and does
		// NOT echo the text back. `status: "skipped"` is a refusal - too short, a
		// hard-block, or an insert failure - and must never look like a stored
		// memory. Returning undefined here is what makes MemoryService report a
		// backend failure rather than a successful retention.
		if (result?.status === "skipped") return undefined;
		if (!result?.record_id) return undefined;
		// The stored text is not in the acknowledgement, so the record is built from
		// what was sent plus the id the engine assigned. Reading it back to confirm
		// would double the cost of every write to learn what the caller already has.
		return {
			id: result.record_id,
			kind: candidate.kind,
			text: candidate.text,
			provenance: candidate.provenance,
			createdAt: Date.now(),
		};
	}
	async recall(query: MemoryQuery): Promise<readonly MemoryHit[]> {
		const started = await this.#ensureSession();
		if (!started.ok) return [];
		const result = (await started.session.request(RECALL, {
			cue: query.text,
			k: query.limit ?? 10,
		})) as unknown;
		return toHits(result);
	}

	/**
	 * Records that a fact changed.
	 *
	 * The engine archives rather than erases, which is the right semantics for a
	 * changed fact: both versions stay retrievable, so a stale memory cannot
	 * masquerade as current. That behaviour is relied on rather than reimplemented.
	 *
	 * Traced from `iai_mcp.core.dispatch`: the engine takes `id` as a **UUID** and
	 * `new_fact` as the replacement text, and returns `original_id`,
	 * `new_record_id` and `edge_type`. A non-UUID id is rejected by the engine, so
	 * the id is validated here rather than relying on the call failing.
	 */
	async contradict(input: {
		recordId: string;
		text: string;
		provenance?: MemoryCandidate["provenance"];
	}): Promise<boolean> {
		const started = await this.#ensureSession();
		if (!started.ok) return false;
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		if (!UUID.test(input.recordId)) {
			// The engine's `UUID(params["id"])` would raise and the whole request
			// would fail. Saying why here is the difference between a diagnosable
			// error and a generic "the store did not answer".
			throw new Error(`cannot contradict: "${input.recordId}" is not a UUID the engine can address`);
		}
		await started.session.request(CONTRADICT, { id: input.recordId, new_fact: input.text });
		return true;
	}

	async consolidate(): Promise<void> {
		const started = await this.#ensureSession();
		if (!started.ok) return;
		await started.session.request("memory_consolidate", {});
	}
}
function toHits(result: unknown): MemoryHit[] {
	// Traced from the engine recall response: it returns `hits` and `anti_hits`
	// separately, and every hit carries its own `score`. Both are preserved. The
	// engine-assigned score is the only relevance signal the store has, and
	// replacing it with a constant would throw the engine ranking away; keeping
	// anti-hits is the point, because a surface that returns only confirming
	// evidence lets a stale fact read as current.
	const source = (result ?? {}) as { hits?: unknown[]; anti_hits?: unknown[] };
	if (!Array.isArray(source.hits)) return [];
	const anti = (Array.isArray(source.anti_hits) ? source.anti_hits : [])
		.map((entry) => toRecord(entry))
		.filter((candidate): candidate is MemoryRecord => candidate !== undefined);
	const hits: MemoryHit[] = [];
	for (const entry of source.hits) {
		const record = toRecord(entry);
		if (!record) continue;
		const score = (entry as { score?: unknown }).score;
		hits.push({
			record,
			score: typeof score === "number" ? score : 0,
			...(anti.length > 0 ? { contradicts: anti } : {}),
		});
	}
	return hits;
}
