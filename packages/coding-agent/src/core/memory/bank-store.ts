/**
 * Project-local bank storage over SQLite.
 *
 * ## What this is
 *
 * A backend that keeps one SQLite bank per project, so a fact learned in one
 * repository is not recalled in another. It is the migration target for the
 * reference's `mnemopi.*` settings, which describe exactly this shape.
 *
 * ## Two invariants the rest of the system depends on
 *
 * 1. **A project's bank is a function of its absolute path alone** - see
 *    {@link computeBankScope}. Adding a `.git` marker above a directory must not
 *    repoint it, because the reference learned that the hard way and stranded
 *    real memories when it got it wrong.
 * 2. **Recall never widens silently.** A bank joins the recall set only when
 *    every row in it belongs to the active project. A bank holding another
 *    project's rows is skipped, not partially read, because the store cannot
 *    filter rows by project and a partial read would leak.
 *
 * ## Why `node:sqlite`
 *
 * It is in the runtime already, so this needs no new dependency and no native
 * build step. The alternative - a JSON file per bank - cannot answer the
 * per-bank row scan the rescue path needs without loading every bank into
 * memory, and a bank directory with a pathological number of banks would
 * dominate startup.
 *
 * ## No embeddings
 *
 * This backend ranks with the shared, explainable {@link rankByRelevance}. An
 * embedding index is a separate capability with its own settings and its own
 * failure modes; pretending a lexical rank is semantic would be the kind of
 * quiet substitution that makes a memory system untrustworthy.
 */

import { type Dirent, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	MemoryBackend,
	MemoryBackendCapabilities,
	MemoryCandidate,
	MemoryHit,
	MemoryQuery,
	MemoryRecord,
} from "./backend.ts";
import { type BankScope, type BankScoping, computeBankScope } from "./bank-scope.ts";
import { sanitizeStoredMemoryText } from "./redact.ts";
import { rankByRelevance } from "./relevance.ts";

/**
 * Cap on banks probed during rescue.
 *
 * A `banks/` directory is user-writable and could contain anything. Without a
 * cap, a directory with ten thousand entries would put ten thousand SQLite
 * opens on the startup path. The reference uses the same limit for the same
 * reason.
 */
const LEGACY_BANK_SCAN_LIMIT = 64;

/** The schema, kept minimal and explicit rather than migrated. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS working_memory (
	id TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'convention',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	cwd TEXT NOT NULL DEFAULT '',
	superseded_by TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS working_memory_cwd ON working_memory (cwd);
`;

export interface BankStoreOptions {
	/** Directory holding `banks/<name>/bank.db`. */
	readonly root: string;
	/** Shared bank base name, from settings. */
	readonly bank?: string;
	readonly scoping?: BankScoping;
	/** Session working directory; the project identity. */
	readonly cwd: string;
	/** Forces a failure, for exercising the failure path. Never in production. */
	readonly failWith?: string;
}

export class BankStoreBackend implements MemoryBackend {
	readonly id = "bank-store";
	readonly label = "Bank Store";
	readonly description = "Per-project SQLite memory banks";

	readonly capabilities: MemoryBackendCapabilities = {
		recall: true,
		retain: true,
		// Consolidation would mean merging facts across banks, which changes what a
		// project knows and is not a store's decision to make.
		consolidate: false,
		persistent: true,
		local: true,
		// Plain SQLite on disk. Claiming encryption would be false, and an
		// over-claiming backend is worse than an under-claiming one.
		encryptedAtRest: false,
	};

	readonly #options: BankStoreOptions;
	readonly #open = new Map<string, DatabaseSync>();

	constructor(options: BankStoreOptions) {
		this.#options = options;
	}

	/** The banks this session writes to and reads from. */
	get scope(): BankScope {
		return computeBankScope(this.#options.bank, this.#options.cwd, this.#options.scoping ?? "per-project");
	}

	async available(): Promise<{ ok: boolean; reason?: string }> {
		if (this.#options.failWith) return { ok: false, reason: this.#options.failWith };
		try {
			this.#database(this.scope.retainBank);
			return { ok: true };
		} catch (error) {
			// Reported rather than thrown: an unwritable store is an unavailable
			// backend, not a session that cannot start.
			return {
				ok: false,
				reason: `bank store is not writable: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	#banksDirectory(): string {
		return path.join(this.#options.root, "banks");
	}

	#database(bank: string): DatabaseSync {
		const existing = this.#open.get(bank);
		if (existing) return existing;
		if (this.#options.failWith) throw new Error(this.#options.failWith);
		const directory = path.join(this.#banksDirectory(), bank);
		mkdirSync(directory, { recursive: true });
		const db = new DatabaseSync(path.join(directory, "bank.db"));
		db.exec(SCHEMA);
		this.#open.set(bank, db);
		return db;
	}

	async retain(candidate: MemoryCandidate): Promise<MemoryRecord> {
		const text = sanitizeStoredMemoryText(candidate.text);
		if (text.length === 0) throw new Error("refusing to store an empty memory");
		const scope = this.scope;
		const db = this.#database(scope.retainBank);
		const createdAt = Date.now();
		// Content-addressed, with no timestamp in the id. The earlier form mixed
		// `createdAt` into the id, so re-running the same seed produced a *new* id
		// every time and `INSERT OR IGNORE` never collided: 45 rows holding 17
		// distinct facts, and recall returned every one of them three times.
		//
		// The store is the authority for its own contents, so the dedup has to live
		// here rather than relying on a caller having checked. Two different
		// projects writing the same fact must still get two records, which the
		// per-bank split already guarantees.
		const id = Math.abs(hashText(text)).toString(36);
		db.prepare(
			"INSERT OR IGNORE INTO working_memory (id, content, kind, metadata_json, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(id, text, candidate.kind, JSON.stringify(candidate.provenance), this.#options.cwd, createdAt);
		// The stored `created_at` may predate this call, if the row already existed.
		// Reporting the attempt time would make a re-retained memory look refreshed,
		// which is how a stale fact starts ranking above a correct one.
		const existing = db.prepare("SELECT created_at FROM working_memory WHERE id = ?").get(id) as
			| { created_at?: number }
			| undefined;
		return {
			id,
			kind: candidate.kind,
			text,
			provenance: candidate.provenance,
			createdAt: existing?.created_at ?? createdAt,
		};
	}

	async recall(query: MemoryQuery): Promise<readonly MemoryHit[]> {
		if (this.#options.failWith) throw new Error(this.#options.failWith);
		const scope = this.scope;
		// `extendRecallWithLegacyBanks` returns the *complete* set - the banks it was
		// given, plus any it rescued. Spreading both would read every bank twice and
		// return each memory as a duplicate, so its result is used directly.
		//
		// Rescue only ever adds a bank whose every row belongs to this project.
		// Widening recall is a leak risk, so it is never done speculatively.
		const banks = extendRecallWithLegacyBanks(
			scope.recallBanks,
			this.#options.root,
			this.#options.cwd,
			this.#options.failWith,
		);
		const records: MemoryRecord[] = [];
		const seen = new Set<string>();
		for (const bank of banks) {
			for (const record of this.#readBank(bank)) {
				// A bank file is user-writable and may predate the content-addressed
				// id, so duplicates are collapsed here as well as prevented on write.
				// Recalling the same fact three times wastes the budget and reads as
				// three independent sources supporting one claim.
				const key = `${record.kind} ${record.text}`;
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(record);
			}
		}
		return rankByRelevance(records, query, query.limit ?? 10);
	}

	#readBank(bank: string): MemoryRecord[] {
		let db: DatabaseSync;
		try {
			db = this.#database(bank);
		} catch {
			// One unreadable bank must not lose recall over the others.
			return [];
		}
		try {
			const rows = db
				.prepare(
					"SELECT id, content, kind, metadata_json, cwd, superseded_by, created_at FROM working_memory ORDER BY created_at DESC",
				)
				.all() as Record<string, unknown>[];
			return rows.map((row) => this.#toRecord(row));
		} catch {
			return [];
		}
	}

	#toRecord(row: Record<string, unknown>): MemoryRecord {
		let provenance: MemoryRecord["provenance"] = { scope: "project" };
		try {
			const parsed = JSON.parse(String(row.metadata_json ?? "{}")) as MemoryRecord["provenance"];
			if (parsed && typeof parsed === "object" && typeof parsed.scope === "string") provenance = parsed;
		} catch {
			// A corrupt metadata blob costs the attribution, not the memory. Dropping
			// the row instead would lose a fact over a cosmetic field.
		}
		return {
			id: String(row.id),
			kind: String(row.kind) as MemoryRecord["kind"],
			// Re-sanitized on read: a bank file is user-writable, so a row hand-edited
			// into a prompt-injection payload must not reach a prompt unfiltered.
			text: sanitizeStoredMemoryText(String(row.content)),
			provenance,
			createdAt: Number(row.created_at) || Date.now(),
			...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
		};
	}

	async list(): Promise<readonly MemoryRecord[]> {
		return this.#readBank(this.scope.retainBank);
	}

	async forget(id: string): Promise<boolean> {
		for (const bank of this.scope.recallBanks) {
			try {
				const result = this.#database(bank).prepare("DELETE FROM working_memory WHERE id = ?").run(id);
				if (Number(result.changes) > 0) return true;
			} catch {
				// Try the next bank.
			}
		}
		return false;
	}

	async stop(): Promise<void> {
		for (const db of this.#open.values()) {
			try {
				db.close();
			} catch {
				// Already closed.
			}
		}
		this.#open.clear();
	}
}

/** A cheap content hash, for a stable id without pulling in a crypto dependency per write. */
function hashText(text: string): number {
	let hash = 0;
	for (let index = 0; index < text.length; index++) {
		hash = (hash * 31 + text.charCodeAt(index)) | 0;
	}
	return hash;
}

/**
 * Finds banks stranded by an earlier, less-stable derivation, and adds only the
 * ones that are unambiguously this project's.
 *
 * ## The rule
 *
 * A candidate bank joins the recall set only when **every** row in it carries
 * the active `cwd`. A bank with any row from another directory is skipped
 * whole.
 *
 * This is stricter than it first looks, and that is the point. The store cannot
 * filter rows by project, so a mixed bank read partially leaks another
 * project's memories into this one. Refusing the whole bank is the only choice
 * that cannot leak. A mixed bank is stranded rather than recalled, which is
 * recoverable and quiet; a leak is neither.
 *
 * Robust by construction: a missing directory, an unreadable entry, or a corrupt
 * database is skipped rather than thrown, because this runs on the startup path.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	root: string,
	cwd: string,
	failWith?: string,
): readonly string[] {
	if (failWith) return resolved;
	const banksDirectory = path.join(root, "banks");
	let entries: Dirent[];
	try {
		entries = readdirSync(banksDirectory, { withFileTypes: true });
	} catch {
		// No banks directory yet is the normal first-run case.
		return resolved;
	}
	const known = new Set(resolved);
	const extras: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || known.has(entry.name)) continue;
		if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
		scanned++;
		if (bankOnlyHasCwd(path.join(banksDirectory, entry.name, "bank.db"), cwd)) extras.push(entry.name);
	}
	return extras.length === 0 ? resolved : [...resolved, ...extras];
}

/**
 * True when the bank has rows for `cwd` and none for anywhere else.
 *
 * Empty banks return false: a bank with no rows proves nothing, and admitting
 * empty banks would let the rescue grow the recall set without bound.
 */
function bankOnlyHasCwd(dbPath: string, cwd: string): boolean {
	// A file check first: opening a SQLite database that does not exist creates
	// it, and a rescue pass must never bring banks into existence.
	try {
		if (!statSync(dbPath).isFile()) return false;
	} catch {
		return false;
	}
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db
			.prepare(
				"SELECT SUM(CASE WHEN cwd = ? THEN 1 ELSE 0 END) AS matching, SUM(CASE WHEN cwd <> ? THEN 1 ELSE 0 END) AS unsafe FROM working_memory",
			)
			.get(cwd, cwd) as { matching?: number | null; unsafe?: number | null } | undefined;
		return (row?.matching ?? 0) > 0 && (row?.unsafe ?? 0) === 0;
	} catch {
		// Not a database, or a schema we do not understand. Skipped.
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// Read-only handle; nothing to release on failure.
		}
	}
}
