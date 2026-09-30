/**
 * The session's memory: one entry point, whichever backend is selected.
 *
 * ## Why this exists
 *
 * Every other memory module takes a `MemoryBackend` and does its job. Nothing
 * decides *which* backend, when it starts, when it stops, or what a session does
 * with a failed recall. That is this module's only job, and keeping it small is
 * the point: the rules live in `retention.ts`, the storage lives in a backend,
 * and the only thing here is lifecycle and wiring.
 *
 * ## Backend selection, and what each state means
 *
 * The four states are kept distinct on purpose, because collapsing them is how
 * a product ends up claiming a capability it has never run:
 *
 * - **registered** — a descriptor exists. Says nothing about behaviour.
 * - **adapter exists** — code can construct it. Says nothing about its engine.
 * - **live verified** — the real backend was run end to end. `local-store` is.
 * - **wired** — a runtime consumer actually calls it, and its behaviour is
 *   proven to the level that capability needs. Nothing is wired yet.
 *
 * `local-store` is live verified and is what the retention pipeline is proven
 * against. `iai-personal` is registered with an adapter and is *not* live
 * verified: its engine has never run here, because its declared dependencies are
 * absent. Selecting it reports that state honestly rather than implying storage
 * works. See PD-9.
 *
 * ## Failure is visible, never silent
 *
 * A session whose memory is unavailable still runs, and says so once. It does
 * not pretend an empty store is a store with nothing in it: those are different
 * facts and only one of them is true.
 */

import path from "node:path";
import type { MemoryBackend, MemoryBackendCapabilities, MemoryQuery, MemoryScope } from "./backend.ts";
import type { BankScoping } from "./bank-scope.ts";
import { buildMemoryContext, type MemoryContext } from "./context.ts";
import { configurePrimePiBackends, createMemoryBackend } from "./registry.ts";
import { type CurrentState, MemoryService, type RecallResult, type WorkEvent } from "./retention.ts";

/** How thoroughly a backend has been exercised. Never inferred from a setting. */
export type BackendEvidence = "registered" | "adapter-exists" | "live-verified" | "wired";

/**
 * What is actually known about each backend.
 *
 * This is a hard-coded claim table, not something derived at runtime, because a
 * runtime probe can tell you a backend answers today and nothing about whether it
 * has ever stored, recalled and superseded correctly. Those are facts about
 * testing, and they change only when someone runs the test.
 */
const EVIDENCE: Readonly<Record<string, BackendEvidence>> = {
	off: "live-verified",
	local: "live-verified",
	hindsight: "registered",
	mnemopi: "registered",
	sharpshooter: "registered",
	"local-store": "live-verified",
	// Live verified: per-project isolation, restart durability and the no-leak
	// property are all exercised against real SQLite banks in the suite.
	"bank-store": "live-verified",
	// Live verified: the engine was installed from its own declared dependencies
	// and exercised end to end - capture, recall, restart persistence, and
	// supersession all proven through this adapter. One derived markdown cache is
	// plaintext; see PD-9.
	"iai-personal": "live-verified",
};

export function backendEvidence(id: string): BackendEvidence {
	return EVIDENCE[id] ?? "registered";
}

/** What a session does with memory, once, at construction. */
export interface MemorySessionOptions {
	/** The backend id from settings. Falls back to `off`, which runs nothing. */
	readonly backendId?: string;
	/** Where local backends write. Ignored by backends with their own storage. */
	readonly agentDir?: string;
	readonly project?: string;
	/**
	 * The per-project bank store's settings, as resolved from the registry.
	 *
	 * Passed as a resolved value rather than read from the registry here, so this
	 * module stays free of the settings layer and a test can construct a session
	 * with any configuration. This is the wiring point that makes the
	 * `mnemopi.dbPath`, `mnemopi.bank` and `mnemopi.scoping` rows consumed rather
	 * than merely declared.
	 */
	readonly bankStore?: BankStoreConfig;
	/** Overrides the default retention policy. */
	readonly policy?: Partial<import("./retention.ts").RetentionPolicy>;
}

/** The resolved bank-store settings a caller supplies. */
export interface BankStoreConfig {
	/**
	 * Where the banks live. Absent means the agent directory, and an absent agent
	 * directory makes the backend report itself unavailable rather than guessing a
	 * path - a memory store that writes into the working directory will eventually
	 * write into a repository.
	 */
	readonly root?: string;
	/** The project identity. Defaults to the process working directory. */
	readonly cwd?: string;
	readonly bank?: string;
	readonly scoping?: BankScoping;
}

/** What a caller needs to know about memory this session. */
export interface MemoryStatus {
	readonly backendId: string;
	readonly evidence: BackendEvidence;
	readonly available: boolean;
	readonly reason?: string;
	/** True when the backend cannot retain or recall at all. */
	readonly inert: boolean;
	/**
	 * What the backend can do, one capability at a time.
	 *
	 * `inert` folds retain and recall together, so it answers "does this backend
	 * run memory at all" but not "may this caller retain". A backend that can
	 * recall but not store is a real shape - a read-only mirror of another
	 * engine - and keying a write path on `!inert` would call it storable.
	 */
	readonly capabilities: MemoryBackendCapabilities;
	/** A sentence a settings panel can show without inventing anything. */
	readonly summary: string;
}

/**
 * One session's memory.
 *
 * Constructed once, at session start. Every method is safe to call on an inert
 * service: `off` produces empty recalls and an explicit "unavailable" rather
 * than throwing, because a memory subsystem must never be the reason a session
 * fails to start.
 */
export class SessionMemory {
	readonly #service: MemoryService;
	readonly #backend: MemoryBackend;
	readonly #available: { ok: boolean; reason?: string };
	/** Warned once per failure, so a broken store cannot flood a transcript. */
	#warned = false;

	private constructor(backend: MemoryBackend, available: { ok: boolean; reason?: string }, project?: string) {
		this.#backend = backend;
		this.#available = available;
		this.#project = project;
		this.#service = new MemoryService(backend);
	}

	/**
	 * Builds the session's memory from a settings value.
	 *
	 * Never throws and never fails session start. A backend that cannot be
	 * constructed degrades to an inert service carrying the reason, because a
	 * missing optional subsystem is not a reason to refuse to work.
	 */
	static async create(options: MemorySessionOptions = {}): Promise<SessionMemory> {
		const id = options.backendId?.trim() || "off";
		// The registry holds one process-wide configuration, so the paths this
		// session was given are installed before the backend is constructed. A
		// backend that owns its own storage ignores them entirely, which is the
		// point: passing a path must not imply the backend needs one.
		if (options.agentDir || options.project || options.bankStore) {
			configurePrimePiBackends({
				...(options.bankStore ? { bankStore: { ...options.bankStore } } : {}),
				...(options.agentDir ? { agentDir: options.agentDir } : {}),
				...(options.project ? { localStore: { project: options.project } } : {}),
			});
		}
		const created = createMemoryBackend(id);
		if (!created.ok) return new SessionMemory(offBackend(), { ok: false, reason: created.reason }, options.project);
		const backend = created.backend;
		try {
			const available = await backend.available();
			if (available.ok) await backend.start?.();
			return new SessionMemory(backend, available, options.project);
		} catch (error) {
			return new SessionMemory(
				offBackend(),
				{ ok: false, reason: error instanceof Error ? error.message : String(error) },
				options.project,
			);
		}
	}

	/** Builds an inert service that stores nothing. */
	static inert(): SessionMemory {
		return new SessionMemory(offBackend(), { ok: true });
	}

	get status(): MemoryStatus {
		const inert = !this.#backend.capabilities.retain || !this.#backend.capabilities.recall;
		return {
			backendId: this.#backend.id,
			evidence: backendEvidence(this.#backend.id),
			available: this.#available.ok,
			...(this.#available.reason ? { reason: this.#available.reason } : {}),
			inert,
			capabilities: this.#backend.capabilities,
			summary: this.#summary(inert),
		};
	}

	#summary(inert: boolean): string {
		const evidence = backendEvidence(this.#backend.id);
		if (!this.#available.ok)
			return `${this.#backend.label} is unavailable: ${this.#available.reason ?? "unknown reason"}.`;
		if (inert) return `${this.#backend.label} runs no memory: it cannot retain or recall.`;
		if (evidence === "adapter-exists") {
			// The distinction that matters, stated in the place a user will read it.
			return `${this.#backend.label}: the adapter is implemented, but the engine has not been run here. Storage and recall are unverified.`;
		}
		if (evidence === "live-verified") {
			return `${this.#backend.label} is live verified: retention, recall and supersession have been exercised end to end.`;
		}
		return `${this.#backend.label} is registered but not verified. Treat its storage as unproven.`;
	}

	/** Offers a work event to the pipeline. */
	async retain(event: WorkEvent): Promise<void> {
		if (this.status.inert) return;
		const result = await this.#service.retainEvent(event);
		if (result.failed.length > 0 && !this.#warned) {
			this.#warned = true;
			// Surfaced rather than swallowed: a memory that was not stored must not
			// pass as one that was.
			this.onWarning?.(
				`${result.failed.length} memories were not stored: ${result.failed[0]?.detail ?? "unknown reason"}`,
			);
		}
	}

	/**
	 * Recalls memory and renders it as a bounded context block.
	 *
	 * The one call a consumer needs. Every other path exists for testing and for
	 * callers that want the structured result.
	 */
	async contextFor(query: MemoryQuery, current: CurrentState = {}, budget?: number): Promise<MemoryContext> {
		const result = await this.#service.recall(query, current);
		return buildMemoryContext(result, { budget, ...(this.#project ? { project: this.#project } : {}) });
	}

	/** The structured recall, for callers that need hits rather than a block. */
	async recall(query: MemoryQuery, current: CurrentState = {}): Promise<RecallResult> {
		return this.#service.recall(query, current);
	}

	/** Called once when a write fails, so the session can report it. */
	#project: string | undefined;

	/** Called once when a write fails, so the session can report it. */
	onWarning?: (message: string) => void;

	/** Releases backend resources. Called on backend switch and at session end. */
	async stop(): Promise<void> {
		try {
			await this.#backend.stop?.();
		} catch {
			// A backend that fails to stop must not take the session down with it.
		}
	}
}

/**
 * The always-available backend.
 *
 * A real object rather than a null check, so every caller takes one path and the
 * type system cannot forget an inert case.
 */
function offBackend(): MemoryBackend {
	return {
		id: "off",
		label: "Off",
		description: "No memory",
		capabilities: {
			recall: false,
			retain: false,
			consolidate: false,
			persistent: false,
			local: true,
			encryptedAtRest: false,
		},
		async available() {
			return { ok: true };
		},
	};
}

/** Where a local backend writes, for a settings panel to display. */
export function localStorePath(agentDir: string): string {
	return path.join(agentDir, "memory");
}

/** Scopes a caller may name, in the order a search widens. */
export const RECALL_SCOPES: readonly MemoryScope[] = ["session", "project", "global"];
