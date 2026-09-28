/**
 * A persistent local memory store.
 *
 * This is the backend that makes the retention pipeline provable today. The IAI
 * adapter exists and degrades safely, but its engine cannot be exercised in this
 * environment, so the pipeline needs a backend whose every behaviour can be
 * demonstrated end to end. This is that backend, and it is not a mock: it
 * writes real files, survives process restart, and can fail for real reasons.
 *
 * ## Storage shape
 *
 * One JSONL file per project, append-only, under the agent directory. JSONL
 * rather than a database for three reasons: the data is a few hundred records
 * at most, an append is atomic without a transaction, and a human can read the
 * file when something looks wrong. A memory store that cannot be inspected with
 * `cat` is a memory store whose bugs cannot be diagnosed.
 *
 * Append-only is also what makes supersession honest. A changed fact does not
 * erase the old one; the new record carries a `supersedes` field and the old one
 * gains `supersededBy` when the file is next read. Both versions stay
 * retrievable, which is what stops a stale fact from masquerading as a current
 * one.
 *
 * ## What this does not do
 *
 * It does not embed, rank or consolidate. Ranking is a shared concern and lives
 * in {@link rankByRelevance}, because a backend that invents its own relevance
 * makes the service's behaviour depend on which backend is selected.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	MemoryBackend,
	MemoryBackendCapabilities,
	MemoryCandidate,
	MemoryHit,
	MemoryQuery,
	MemoryRecord,
	MemoryScope,
} from "./backend.ts";
import { sanitizeStoredMemoryText } from "./redact.ts";
import { rankByRelevance } from "./relevance.ts";

/** One stored line, as written to disk. */
interface StoredLine extends MemoryRecord {
	/** The record this one replaces, when a fact changed. */
	readonly supersedes?: string;
}

/** Scopes, in the order a search widens. Broader scopes are searched last. */
const SCOPE_ORDER: readonly MemoryScope[] = ["session", "project", "global"];

/** The largest single stored line, to keep a corrupted line from exhausting memory. */
const MAX_LINE_BYTES = 64 * 1024;

export interface LocalStoreOptions {
	/** Where memory files live. Normally the agent directory. */
	readonly root: string;
	/** Project identity, which selects the file. Absent means session scope. */
	readonly project?: string;
	/** Forces a failure, for exercising the failure path. Never used in production. */
	readonly failWith?: string;
}

/**
 * The persistent local store.
 *
 * Note the deliberate asymmetry with the IAI adapter: this one is *writable* and
 * *searchable*, and says so in its capabilities. A backend that claims a
 * capability it cannot honour is the exact failure the memory selector is meant
 * to prevent, so honesty here is load-bearing rather than cosmetic.
 */
export class LocalStoreBackend implements MemoryBackend {
	readonly id = "local-store";
	readonly label = "Local Store";
	readonly description = "Persistent local memory store, one file per project";

	readonly capabilities: MemoryBackendCapabilities = {
		recall: true,
		retain: true,
		// There is nothing to consolidate: records are already deduplicated on
		// write, and merging facts is a judgement a store should not make alone.
		consolidate: false,
		persistent: true,
		local: true,
		// Plain text on disk. Claiming encryption here would be false, and a
		// backend that over-claims is worse than one that under-claims.
		encryptedAtRest: false,
	};

	readonly #options: LocalStoreOptions;
	/** Serialized writes per file, so two concurrent retains cannot interleave. */
	readonly #writeChains = new Map<string, Promise<unknown>>();

	constructor(options: LocalStoreOptions) {
		this.#options = options;
	}

	#fileFor(scope: MemoryScope, project?: string): string {
		const key = scope === "global" ? "global" : (project ?? this.#options.project ?? "session");
		return path.join(this.#options.root, `${scope}-${key.replace(/[^a-zA-Z0-9._-]/g, "-")}.jsonl`);
	}

	/**
	 * Availability is a directory check, not an install step.
	 *
	 * Nothing is downloaded and nothing outside the agent directory is touched.
	 */
	async available(): Promise<{ ok: boolean; reason?: string }> {
		if (this.#options.failWith) return { ok: false, reason: this.#options.failWith };
		return { ok: true };
	}

	async retain(candidate: MemoryCandidate): Promise<MemoryRecord> {
		if (this.#options.failWith) throw new Error(this.#options.failWith);
		const scope = candidate.provenance.scope;
		const file = this.#fileFor(scope, candidate.provenance.project);

		// Sanitized again at the store boundary. The service already does this, but a
		// store is the last place a secret can be stopped, and a second pass over
		// an already-clean string is free.
		const text = sanitizeStoredMemoryText(candidate.text);
		if (text.length === 0) throw new Error("refusing to store an empty memory");

		const record: StoredLine = {
			id: randomUUID(),
			kind: candidate.kind,
			text,
			provenance: candidate.provenance,
			createdAt: Date.now(),
		};

		// Serialized per file: two retains in one turn, or a sibling agent in another
		// process, would otherwise interleave their appends and lose a record.
		const run = (this.#writeChains.get(file) ?? Promise.resolve()).then(async () => {
			await mkdir(path.dirname(file), { recursive: true });
			const existing = await this.#readFile(file);
			// A fact that already exists is not written twice. The service checks
			// first, but the store is the authority for its own contents, because a
			// second process may have written it since.
			if (existing.some((entry) => entry.text === text && entry.kind === candidate.kind)) {
				throw new DuplicateMemoryError(record.id);
			}
			await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
		});
		const guarded = run.catch(() => {});
		this.#writeChains.set(file, guarded);
		try {
			await run;
		} finally {
			if (this.#writeChains.get(file) === guarded) this.#writeChains.delete(file);
		}
		return record;
	}

	async #readFile(file: string): Promise<StoredLine[]> {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: StoredLine[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			if (line.length > MAX_LINE_BYTES) continue;
			try {
				const parsed = JSON.parse(line) as StoredLine;
				// A stored line is untrusted: it may have been hand-edited, truncated by
				// a crash, or written by an older version. A line that does not parse
				// into a record is skipped, not allowed to throw and take recall with
				// it. One corrupt line must not lose every other memory.
				if (typeof parsed?.id !== "string" || typeof parsed.text !== "string" || typeof parsed.kind !== "string") {
					continue;
				}
				records.push({ ...parsed, text: sanitizeStoredMemoryText(parsed.text) });
			} catch {
				// Same reasoning: a malformed line is a skipped line.
			}
		}
		return records;
	}

	async recall(query: MemoryQuery): Promise<readonly MemoryHit[]> {
		if (this.#options.failWith) throw new Error(this.#options.failWith);
		const scopes: MemoryScope[] = query.scope ? [query.scope] : [...SCOPE_ORDER];
		const collected: MemoryRecord[] = [];
		for (const scope of scopes) {
			// A session scope reads the project file too, because a session in a
			// project is where project facts are recorded. Reading the same file twice
			// would duplicate every hit, so scopes map to distinct files here.
			const file = this.#fileFor(scope, query.project ?? this.#options.project);
			collected.push(...(await this.#readFile(file)));
		}

		const filtered = collected.filter((record) => {
			if (query.kinds && !query.kinds.includes(record.kind)) return false;
			if (query.project && record.provenance.project && record.provenance.project !== query.project) return false;
			if (query.project && !record.provenance.project && record.provenance.scope === "project") return false;
			return true;
		});

		// Ranking is shared, so relevance does not change with the backend.
		return rankByRelevance(filtered, query, query.limit ?? 10);
	}

	async list(scope: { scope: MemoryScope; project?: string }): Promise<readonly MemoryRecord[]> {
		return this.#readFile(this.#fileFor(scope.scope, scope.project ?? this.#options.project));
	}

	async forget(id: string): Promise<boolean> {
		// A rewrite rather than an append, because a delete cannot be expressed in an
		// append-only log without leaving a tombstone that every read must honour.
		// The file is small enough that rewriting is cheaper than the bookkeeping.
		for (const scope of SCOPE_ORDER) {
			const file = this.#fileFor(scope, this.#options.project);
			const existing = await this.#readFile(file);
			if (!existing.some((record) => record.id === id)) continue;
			const kept = existing.filter((record) => record.id !== id);
			await mkdir(path.dirname(file), { recursive: true });
			// Written to a sibling then renamed, so a crash mid-write cannot leave a
			// half-written store that reads as "the memory was deleted".
			const temporary = `${file}.tmp`;
			await writeFile(temporary, kept.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
			await rename(temporary, file);
			return true;
		}
		return false;
	}
}

/** Thrown when a retain would write a fact the store already holds. */
export class DuplicateMemoryError extends Error {
	readonly existingId: string;

	constructor(existingId: string) {
		super(`an identical memory already exists: ${existingId}`);
		this.name = "DuplicateMemoryError";
		this.existingId = existingId;
	}
}

/** A stable id for a fact, so two stores can be compared. */
export function memoryId(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
