/**
 * The memory backend registry: the OMP selector, in the reference's order.
 *
 * ## Order is the contract
 *
 * The five OMP backends appear in exactly the order the reference renders them,
 * because the list is positional: a user who has learned where Sharpshooter
 * sits selects by position. A PrimePi backend appends *after* them, so the
 * reference's ordering and count are untouched and the addition is visibly
 * additional.
 *
 * ## A backend that cannot run says so
 *
 * `Off` and `Local` are implemented here. Hindsight, Mnemopi and Sharpshooter
 * are OMP subsystems whose runtimes are not yet migrated, so they are registered
 * as descriptors whose `create()` returns an explicit unavailability reason. The
 * selector still lists them at their OMP positions with their OMP
 * descriptions, and selecting one reports what is missing rather than silently
 * doing nothing.
 *
 * That is the honest arrangement: the panel structure is complete, the rows that
 * depend on un-migrated subsystems are marked, and activating one later is a
 * change to this file rather than to the panel.
 */

import type { MemoryBackend, MemoryBackendDescriptor } from "./backend.ts";

/** A descriptor for a backend that is expected to be unavailable right now. */
function pending(
	id: string,
	label: string,
	description: string,
	ompRank: number,
	reason: string,
): MemoryBackendDescriptor {
	return {
		id,
		label,
		description,
		ompRank,
		create: () => ({ unavailable: reason }),
	};
}

/**
 * A minimal in-process backend: remembers for the life of the session and
 * forgets at exit.
 *
 * Deliberately not persisted. `Local` in the reference is a summary pipeline
 * writing `memory_summary.md`; the durable local backend in PrimePi is the
 * personal memory engine, registered separately. Keeping this one
 * process-scoped means selecting `Local` has an honest meaning rather than
 * implying durability it does not have.
 */
class SessionMemoryBackend implements MemoryBackend {
	readonly id = "local";
	readonly label = "Local";
	readonly description = "Local rollout summarisation pipeline (memory_summary.md)";
	readonly capabilities = {
		recall: true,
		retain: true,
		// No consolidation: there is nothing to consolidate in a session's worth of
		// memory, and claiming otherwise would be a control backed by nothing.
		consolidate: false,
		persistent: false,
		local: true,
		encryptedAtRest: false,
	} as const;

	#records = new Map<string, MemoryRecordLike>();
	#next = 1;

	async available(): Promise<{ ok: boolean }> {
		return { ok: true };
	}

	async retain(candidate: Parameters<NonNullable<MemoryBackend["retain"]>>[0]) {
		const id = `session-${this.#next++}`;
		const record: MemoryRecordLike = {
			id,
			kind: candidate.kind,
			text: candidate.text,
			provenance: candidate.provenance,
			createdAt: Date.now(),
		};
		this.#records.set(id, record);
		return record;
	}

	async recall(query: Parameters<NonNullable<MemoryBackend["recall"]>>[0]) {
		const needle = query.text.trim().toLowerCase();
		if (needle.length === 0) return [];
		const limit = query.limit ?? 10;
		const hits = [...this.#records.values()]
			.filter((record) => {
				if (query.scope && record.provenance.scope !== query.scope) return false;
				if (query.kinds && !query.kinds.includes(record.kind)) return false;
				return record.text.toLowerCase().includes(needle);
			})
			// A naive substring match is exactly the failure this backend must not
			// have: a session memory is a context convenience, and a search over it
			// returning a confident wrong match would be worse than returning
			// nothing.
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(0, limit)
			.map((record) => ({ record, score: 1 }));
		return hits;
	}

	async list() {
		return [...this.#records.values()];
	}

	async forget(id: string) {
		return this.#records.delete(id);
	}
}

interface MemoryRecordLike {
	id: string;
	kind: Parameters<NonNullable<MemoryBackend["retain"]>>[0]["kind"];
	text: string;
	provenance: Parameters<NonNullable<MemoryBackend["retain"]>>[0]["provenance"];
	createdAt: number;
}

/** The selector, in the reference's order. */
export const MEMORY_BACKEND_DESCRIPTORS: readonly MemoryBackendDescriptor[] = [
	{
		id: "off",
		label: "Off",
		description: "No memory subsystem runs",
		ompRank: 0,
		create: () => ({
			id: "off",
			label: "Off",
			description: "No memory subsystem runs",
			capabilities: {
				recall: false,
				retain: false,
				consolidate: false,
				persistent: false,
				local: true,
				encryptedAtRest: false,
			},
			available: async () => ({ ok: true }),
		}),
	},
	{
		id: "local",
		label: "Local",
		description: "Local rollout summarisation pipeline (memory_summary.md)",
		ompRank: 1,
		create: () => new SessionMemoryBackend(),
	},
	pending(
		"hindsight",
		"Hindsight",
		"Vectorize Hindsight remote memory service",
		2,
		"Hindsight is a remote memory service and its client is not migrated into PrimePi",
	),
	pending(
		"mnemopi",
		"Mnemopi",
		"Local SQLite recall/retain backend with optional embeddings",
		3,
		"Mnemopi's SQLite recall/retain backend is not migrated into PrimePi",
	),
	pending(
		"sharpshooter",
		"Sharpshooter",
		"Model-driven extraction and consolidation over the memory store",
		4,
		"Sharpshooter's extraction and consolidation runtime is not migrated into PrimePi",
	),
];

/** Registered PrimePi backends, appended after every OMP entry. */
const PRIMEPI_DESCRIPTORS: MemoryBackendDescriptor[] = [];

/** The full selector: OMP's five in order, then any PrimePi additions. */
export function memoryBackendDescriptors(): readonly MemoryBackendDescriptor[] {
	return [...MEMORY_BACKEND_DESCRIPTORS, ...PRIMEPI_DESCRIPTORS];
}

/** Registers a PrimePi backend, appended after the reference's list. */
export function registerPrimePiBackend(descriptor: Omit<MemoryBackendDescriptor, "ompRank">): void {
	if (PRIMEPI_DESCRIPTORS.some((existing) => existing.id === descriptor.id)) return;
	PRIMEPI_DESCRIPTORS.push({ ...descriptor, ompRank: undefined });
}

/** The descriptor for a value, or undefined when the value names no backend. */
export function descriptorFor(value: string): MemoryBackendDescriptor | undefined {
	return memoryBackendDescriptors().find((descriptor) => descriptor.id === value);
}

/**
 * Instantiates a backend, or reports why it cannot be instantiated.
 *
 * A missing backend is not silently treated as `off`: a user who selected
 * Sharpshooter and got silence would reasonably conclude the feature is broken
 * rather than unmigrated.
 */
export function createMemoryBackend(
	value: string,
): { ok: true; backend: MemoryBackend } | { ok: false; reason: string } {
	const descriptor = descriptorFor(value);
	if (!descriptor) {
		return { ok: false, reason: `"${value}" is not a known memory backend` };
	}
	const created = descriptor.create();
	if ("unavailable" in created) {
		return { ok: false, reason: created.unavailable };
	}
	return { ok: true, backend: created };
}
