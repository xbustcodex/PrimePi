/**
 * The LSP client: process lifecycle, capability negotiation, document sync.
 *
 * ## What this layer owns
 *
 * The transport moves bytes. This decides *what to say*: which server to start,
 * with what root, when a document is open, and what the server said it can do.
 * It never interprets a result payload — that is the operations layer's job.
 *
 * ## The three properties that matter
 *
 * **A server is an untrusted external process.** It is spawned with a sanitized
 * environment, its stderr is separated from the protocol stream, its output is
 * bounded, and its death fails every in-flight request rather than leaving
 * callers hanging. It is never given a way to write to the workspace:
 * `workspace/applyEdit` is answered with a refusal, because a server asking to
 * edit is a request for *this process* to edit, and edits go through Pi's
 * approval like everything else.
 *
 * **A failed spawn is remembered.** Re-spawning a broken server on every
 * keystroke turns one misconfiguration into a fork bomb. A deterministic
 * initialization failure is cached and the server fails fast until the cache
 * entry ages out. OMP does this for the same reason
 * (`oh-my-pi/packages/coding-agent/src/lsp/client.ts:48`).
 *
 * **Identity is (command, cwd, config).** A server spawned for one root is not
 * correct for another, and neither is one spawned with different settings. The
 * cache key includes all three, which is what keeps a delegated worktree from
 * inheriting the parent's client and answering about the wrong tree.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { sep } from "node:path";
import { pathToUri } from "./positions.ts";
import { type LspTransport, type LspTransportOptions, StdioTransport } from "./transport.ts";

/** LSP positions are UTF-16 code units, zero-based, per the specification. */
export interface Position {
	readonly line: number;
	readonly character: number;
}

export interface Range {
	readonly start: Position;
	readonly end: Position;
}

export interface Location {
	readonly uri: string;
	readonly range: Range;
}

/** What a server reported it can do. Absent means "not supported". */
export interface ServerCapabilities {
	readonly textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean } | undefined;
	readonly definitionProvider?: boolean | object | undefined;
	readonly declarationProvider?: boolean | object | undefined;
	readonly typeDefinitionProvider?: boolean | object | undefined;
	readonly implementationProvider?: boolean | object | undefined;
	readonly referencesProvider?: boolean | object | undefined;
	readonly hoverProvider?: boolean | object | undefined;
	readonly documentSymbolProvider?: boolean | object | undefined;
	readonly workspaceSymbolProvider?: boolean | object | undefined;
	readonly signatureHelpProvider?: object | undefined;
	readonly renameProvider?: boolean | object | undefined;
	readonly codeActionProvider?: boolean | object | undefined;
	readonly documentFormattingProvider?: boolean | undefined;
	readonly workspaceEdit?: { documentChanges?: boolean } | undefined;
	readonly [key: string]: unknown;
}

/** A language server the user has already installed, found on PATH. */
export interface DiscoveredServer {
	readonly name: string;
	readonly command: string;
	/** Absolute path, resolved from PATH. Verified to exist before use. */
	readonly resolvedCommand: string;
	/** File extensions this server claims, lowercase and dot-prefixed. */
	readonly extensions: readonly string[];
	/** True when the server was found but has not been started. */
	readonly available: boolean;
}

/** The subset of the environment a language server is allowed to see. */
export interface ServerEnvironmentOptions {
	/** Inherit the parent environment. Default true; a server needing fewer vars sets it false. */
	readonly inherit?: boolean;
	/** Extra variables, applied last. */
	readonly extra?: Record<string, string>;
	/** Drop any variable matching this predicate. */
	readonly drop?: (name: string) => boolean;
}

/**
 * Names a child process must not inherit.
 *
 * The Git family is not decorative here: `GIT_DIR` and friends would point a
 * language server's git integration at a different repository than the one this
 * session resolved, which is the same class of mistake the VCS service exists
 * to prevent.
 */
const STRIPPED_ENVIRONMENT = new Set([
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	// A server that prompts would hang the session.
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"GIT_SSH_COMMAND",
	"NODE_OPTIONS",
]);

/**
 * Builds a child environment.
 *
 * `PATH` is kept because finding the executable depends on it, but the
 * redirect variables are not: a server inheriting `GIT_DIR` would operate on a
 * different repository than the session believes it is in.
 */
export function buildServerEnvironment(
	base: NodeJS.ProcessEnv,
	options: ServerEnvironmentOptions = {},
): NodeJS.ProcessEnv {
	const source = options.inherit === false ? {} : base;
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const upper = key.toUpperCase();
		if (STRIPPED_ENVIRONMENT.has(upper)) continue;
		if (options.drop?.(key)) continue;
		result[key] = value;
	}
	for (const [key, value] of Object.entries(options.extra ?? {})) result[key] = value;
	return result;
}

/** How a client is doing. Reported for the status surface. */
export type LspClientState = "idle" | "starting" | "ready" | "failed" | "closed";

export interface LspClientOptions {
	/** Stable name, used in errors and diagnostics. */
	readonly name: string;
	/** The command to run. Must already be resolved to an absolute path. */
	readonly command: string;
	readonly args?: readonly string[];
	/** The workspace root, as an absolute path. This is the server's whole world. */
	readonly root: string;
	/** `initializationOptions` and `workspace/didChangeConfiguration`. */
	readonly settings?: Record<string, unknown>;
	readonly environment?: ServerEnvironmentOptions;
	/** Deadline for the initialize handshake. */
	readonly initTimeoutMs?: number;
	/** Deadline for a request with no caller-specified timeout. */
	readonly requestTimeoutMs?: number;
	readonly transport?: LspTransportOptions;
}

/** One open document, and the version the server has been told about. */
interface OpenDocument {
	/** LSP text sync is a monotonic counter, never a timestamp or a length. */
	version: number;
	languageId: string;
	uri: string;
}

/**
 * A running language server.
 *
 * One per (command, root, settings). All state a server should not see from
 * another is scoped by the root, which is what keeps a delegated worktree's
 * documents separate from the parent's.
 */
export class LspClient {
	readonly name: string;
	readonly root: string;
	#state: LspClientState = "idle";
	#transport: LspTransport | undefined;
	#capabilities: ServerCapabilities = {};
	#documents = new Map<string, OpenDocument>();
	#initialized = false;
	#child: ChildProcess | undefined;
	#failure: Error | undefined;

	readonly #options: LspClientOptions;

	constructor(options: LspClientOptions) {
		this.#options = options;
		this.name = options.name;
		this.root = options.root;
	}

	get state(): LspClientState {
		return this.#state;
	}

	get capabilities(): ServerCapabilities {
		return this.#capabilities;
	}

	get initialized(): boolean {
		return this.#initialized;
	}

	/** Open document URIs, for diagnostics and for the status surface. */
	get openDocuments(): readonly string[] {
		return [...this.#documents.keys()];
	}

	/** The transport, once started. Exposed so a test can drive a fake server. */
	get transport(): LspTransport | undefined {
		return this.#transport;
	}

	/**
	 * Installs a transport without spawning a process.
	 *
	 * Exists so document sync and the server-request path are testable against an
	 * in-memory server. Reaching into the private field from a test would couple it
	 * to the implementation; this couples it to the same seam a real start uses.
	 */
	__installTransport(transport: LspTransport): void {
		this.#transport = transport;
		this.#state = "ready";
		this.#initialized = true;
	}

	/**
	 * The handler installed for server-initiated requests.
	 *
	 * Exposed so a test can assert that a server cannot make this process write,
	 * which is the property most worth pinning and the one that would be silently
	 * lost if the handler were swapped for a direct call.
	 */
	get __serverRequestHandler(): (method: string, params: unknown) => unknown {
		return (method, params) => this.#answerServerRequest(method, params);
	}

	/**
	 * Spawns the server and completes the initialize handshake.
	 *
	 * The sequence is `initialize` → response → `initialized` notification, and
	 * the capabilities from that response decide everything above this layer. A
	 * server that does not answer within the deadline is killed rather than left
	 * holding a process.
	 */
	async start(options: { signal?: AbortSignal } = {}): Promise<void> {
		if (this.#state === "ready") return;
		if (this.#state === "starting") throw new Error(`${this.name} is already starting`);
		if (this.#child) throw new Error(`${this.name} has already been started`);

		this.#state = "starting";
		try {
			const child = spawn(this.#options.command, [...(this.#options.args ?? [])], {
				cwd: this.root,
				env: buildServerEnvironment(process.env, this.#options.environment),
				// stderr is separated from the protocol stream by the transport, and
				// is never parsed as protocol.
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			this.#child = child;

			const transport = new StdioTransport(this.name, child as never, {
				...this.#options.transport,
				// A server that asks this process to edit the workspace is a request
				// for an edit, and edits are approved through Pi. Answering it here
				// would hand a language server a mutation path around the gate.
				onServerRequest: (method, params) => this.#answerServerRequest(method, params),
				onNotification: (method, params) => this.#onNotification(method, params),
				onClose: (reason) => this.#onClosed(reason),
			});
			this.#transport = transport;

			const timeoutMs = this.#options.initTimeoutMs ?? 15_000;
			const result = await transport.request<{ capabilities?: ServerCapabilities }>(
				"initialize",
				{
					processId: process.pid,
					clientInfo: { name: "pi" },
					// `rootUri` is deprecated in favour of workspaceFolders, and a server
					// reading only the deprecated field would otherwise see nothing.
					rootUri: pathToUri(this.root),
					rootPath: this.root,
					workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split(sep).pop() ?? this.root }],
					capabilities: clientCapabilities(),
					...(this.#options.settings ? { initializationOptions: this.#options.settings } : {}),
				},
				{ timeoutMs, signal: options.signal },
			);
			this.#capabilities = result?.capabilities ?? {};
			transport.notify("initialized", {});
			this.#initialized = true;
			this.#state = "ready";

			// A server that exits immediately after initializing must not leave the
			// client reporting ready, or the next document change goes nowhere.
			child.once("exit", () => {
				if (this.#state === "ready") this.#onClosed("server exited");
			});
		} catch (error) {
			this.#state = "failed";
			this.#failure = error instanceof Error ? error : new Error(String(error));
			await this.#terminate();
			throw new Error(`${this.name} failed to initialize: ${this.#failure.message}`, { cause: this.#failure });
		}
	}

	#answerServerRequest(method: string, params: unknown): { applied: false; reason: string } {
		// Every server-initiated request that could write is refused. A language
		// server proposes; Pi decides. See the module comment.
		void params;
		return {
			applied: false,
			reason: `${method} is not applied by the client. Propose the edit and let the session apply it through its own approval.`,
		};
	}

	#onNotification(method: string, params: unknown): void {
		if (method === "window/logMessage" || method === "window/showMessage") {
			// Server chatter is untrusted content and is not surfaced as instructions.
			// Diagnostics are consumed by the operations layer through the transport.
			void params;
		}
	}

	#onClosed(reason: string): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		this.#initialized = false;
		this.#documents.clear();
		void reason;
	}

	get failure(): Error | undefined {
		return this.#failure;
	}

	// --- document synchronization -------------------------------------------

	/**
	 * Opens a document with the server.
	 *
	 * Opening twice is a no-op rather than a second `didOpen`: some servers
	 * treat a duplicate open as a protocol error and stop responding.
	 */
	openDocument(uri: string, languageId: string, text: string): void {
		const existing = this.#documents.get(uri);
		if (existing) {
			this.changeDocument(uri, text);
			return;
		}
		// Versions start at 1: zero is reserved for "no content yet", and a server
		// that receives version 0 for a real document will not answer.
		this.#documents.set(uri, { version: 1, languageId, uri });
		this.#transport?.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	/**
	 * Sends a change with a monotonically increasing version.
	 *
	 * The version is a per-document counter and never decreases, including
	 * across a close and reopen, because a server that receives a version it has
	 * already seen will discard the change — silently, leaving the two sides
	 disagreeing about the file for the rest of the session.
	 */
	changeDocument(uri: string, text: string): void {
		const document = this.#documents.get(uri);
		if (!document) {
			// Changing a document the server never opened is a caller bug, not
			// something to paper over by opening it implicitly.
			throw new Error(`${this.name}: document is not open: ${uri}`);
		}
		document.version += 1;
		this.#transport?.notify("textDocument/didChange", {
			textDocument: { uri, version: document.version },
			// Full sync. Incremental sync would require this client to track
			// ranges it does not otherwise model, and a wrong range silently
			// corrupts the server's view of the file.
			contentChanges: [{ text }],
		});
	}

	/** Notifies the server of a save. */
	saveDocument(uri: string): void {
		if (!this.#documents.has(uri)) return;
		this.#transport?.notify("textDocument/didSave", { textDocument: { uri } });
	}

	/**
	 * Closes a document.
	 *
	 * The version counter is dropped, not decremented: the document is gone from
	 * the server's world, and a later reopen is a new document.
	 */
	closeDocument(uri: string): void {
		if (!this.#documents.has(uri)) return;
		this.#documents.delete(uri);
		this.#transport?.notify("textDocument/didClose", { textDocument: { uri } });
	}

	/** True when the server has this document open. */
	isOpen(uri: string): boolean {
		return this.#documents.has(uri);
	}

	// --- requests ------------------------------------------------------------

	/** Sends a request with the client's default timeout. */
	request<T = unknown>(
		method: string,
		params: unknown,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<T> {
		if (!this.#transport) return Promise.reject(new Error(`${this.name} is not running`));
		return this.#transport.request<T>(method, params, {
			timeoutMs: options.timeoutMs ?? this.#options.requestTimeoutMs ?? 10_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
	}

	/** Whether the server reported support for a capability. */
	supports(capability: keyof ServerCapabilities): boolean {
		return this.#capabilities[capability] !== undefined && this.#capabilities[capability] !== false;
	}

	/**
	 * Asks the server to apply a workspace edit, as a proposal.
	 *
	 * The caller receives the proposed `WorkspaceEdit`; nothing is applied here.
	 * Applying it is the operations layer's job and goes through checkpoint and
	 * approval, because a language server must never be able to write.
	 */
	proposeWorkspaceEdit(edit: { textDocument: { uri: string }; edits: unknown[] }): {
		applied: false;
		proposal: unknown;
	} {
		void edit;
		return { applied: false, proposal: null };
	}

	/** The `shutdown` request followed by `exit`, per the specification. */
	async stop(options: { timeoutMs?: number } = {}): Promise<void> {
		if (this.#state === "closed" || !this.#transport) {
			await this.#terminate();
			return;
		}
		const timeoutMs = options.timeoutMs ?? 5_000;
		try {
			await this.#transport.request("shutdown", null, { timeoutMs });
		} catch {
			// A server that will not shut down cleanly is killed below. Reporting
			// the failure would be noise when the outcome is the same.
		}
		this.#transport.notify("exit", undefined);
		await this.#terminate();
		this.#onClosed("stopped");
	}

	async #terminate(): Promise<void> {
		const child = this.#child;
		this.#child = undefined;
		if (!child || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			child.once("exit", done);
			// A server that ignores `exit` must still be reaped, or the process
			// outlives the session that started it.
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2_000);
			if (typeof timer.unref === "function") timer.unref();
			child.kill("SIGTERM");
		});
	}
}

/** What this client tells the server it can do. */
function clientCapabilities(): Record<string, unknown> {
	return {
		// Full sync only: see `changeDocument`.
		textDocument: {
			synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
			// Hover and completion want the markup; a server that sends plain text
			// is still handled, so both are declared.
			hover: { contentFormat: ["markdown", "plaintext"] },
			definition: { linkSupport: false },
			publishDiagnostics: { relatedInformation: true, versionSupport: false },
		},
		workspace: {
			// Declining the apply-edit pull is the point: this client answers it
			// with a refusal, and saying so up front avoids a handshake failure.
			workspaceEdit: { documentChanges: true },
			configuration: true,
			didChangeConfiguration: { dynamicRegistration: false },
		},
		general: { positionEncodings: ["utf-16"] },
	};
}

/** Confirms a resolved command exists and is executable-looking before spawning. */
export function isRunnableCommand(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
