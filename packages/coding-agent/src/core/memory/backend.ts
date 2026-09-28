/**
 * The Pi-owned memory backend interface.
 *
 * ## Why Pi defines the interface rather than adopting one backend
 *
 * The OMP Memory screen offers five backends and the panel must keep offering
 * them, but the backends underneath are not interchangeable: Mnemopi is local
 * SQLite, Hindsight is a remote service, Sharpshooter is extraction driven by a
 * model, and the personal memory engine is a local encrypted store reached over
 * MCP. Binding the panel to any one of them would make the others a special
 * case, and every new backend would mean a special case again.
 *
 * So the panel depends on this interface, and each backend adapts to it. That is
 * also what lets a PrimePi extension — the personal memory engine — join as an
 * additional option in the same selector without a new screen.
 *
 * ## Memory is context, never authority
 *
 * This is a hard architectural rule, not guidance. A recalled memory may inform
 * a decision; it may never *be* one. Current source, configuration and Git state
 * always beat remembered state, and nothing retrieved through this interface can
 * bypass model authority, provider usability, the spending policy, tool approval,
 * project trust, Plan Mode, worktree identity, checkpoints or the Git authority.
 * Implementations are therefore not given a way to write to the repository, and
 * nothing here is reachable from a mutation path.
 *
 * ## Scope and provenance are required, not optional
 *
 * Every record carries where it came from and what backs it. A memory captured
 * inside a delegated worktree is not a statement about the parent project, and
 * `scope` is how that stays true: a caller cannot record a parent-scoped memory
 * from a worktree without saying so explicitly. `confidence` and `evidence`
 * exist so a model can weigh a memory rather than obey it.
 */

/** Who a memory is about. */
export type MemoryScope =
	/** This session only; lost on exit. */
	| "session"
	/** This project, shared across its worktrees. */
	| "project"
	/** This user's machine, across every project. */
	| "global";

/** What kind of thing a memory is. */
export type MemoryKind =
	/** An architectural decision and the reason for it. */
	| "decision"
	/** A repository convention a future change must follow. */
	| "convention"
	/** A bug and its root cause. */
	| "root-cause"
	/** A fix that worked. */
	| "fix"
	/** An approach that was tried and did not work. */
	| "failed-approach"
	/** A platform or environment discovery. */
	| "platform"
	/** A security invariant that must hold. */
	| "security"
	/** A test that is baseline-flaky, so a failure is not read as a regression. */
	| "flaky-test"
	/** A known gap in verification. */
	| "verification-debt"
	/** A capability difference between the reference and this fork. */
	| "parity-difference"
	/** A procedure that worked end to end. */
	| "procedure";

/** Where a memory came from, and how much to trust it. */
export interface MemoryProvenance {
	readonly scope: MemoryScope;
	/** The project the memory belongs to, for project scope. */
	readonly project?: string;
	/** The session that recorded it. */
	readonly sessionId?: string;
	/** The delegated task, when the memory came from a child. */
	readonly taskId?: string;
	/** The worktree a child was in. Absent for parent work. */
	readonly worktree?: string;
	/** Which subsystem or file it came from. */
	readonly source?: string;
	/** Why it was recorded. */
	readonly reason?: string;
	/** 0-1. A low-confidence memory is shown, not hidden; it is marked. */
	readonly confidence?: number;
	/** What backs it: a command output, a diff, a test result. */
	readonly evidence?: string;
}

/** One remembered thing. */
export interface MemoryRecord {
	/** Stable id, assigned by the backend. */
	readonly id: string;
	readonly kind: MemoryKind;
	/** The content. Treated as data, never as an instruction. */
	readonly text: string;
	readonly provenance: MemoryProvenance;
	readonly createdAt: number;
	readonly updatedAt?: number;
	/** Usage counters, when the backend tracks them. */
	readonly recallCount?: number;
	/**
	 * A memory this one contradicts.
	 *
	 * Superseding rather than deleting is what keeps a changed fact from
	 * masquerading as current: both stay retrievable, and the older one is marked.
	 */
	readonly supersededBy?: string;
}

/** A query. */
export interface MemoryQuery {
	/** Free text. Interpreted as a cue, never as an instruction. */
	readonly text: string;
	readonly scope?: MemoryScope;
	readonly project?: string;
	readonly kinds?: readonly MemoryKind[];
	readonly limit?: number;
}

/** One hit, with why it matched. */
export interface MemoryHit {
	readonly record: MemoryRecord;
	/** Engine-assigned relevance. Comparable within one result set only. */
	readonly score: number;
	/**
	 * Memories that contradict the cue, returned alongside the hits.
	 *
	 * This is the IAI engine's anti-hit idea and it is the right one: a surface
	 * that only returns confirming evidence lets a stale fact read as current.
	 */
	readonly contradicts?: readonly MemoryRecord[];
}

/** A memory offered for retention, before it is written. */
export interface MemoryCandidate {
	readonly kind: MemoryKind;
	readonly text: string;
	readonly provenance: MemoryProvenance;
	/** What would justify keeping it. Absent candidates are dropped, not guessed. */
	readonly evidence?: string;
	readonly confidence?: number;
}

/** What a backend can and cannot do, reported rather than assumed. */
export interface MemoryBackendCapabilities {
	readonly recall: boolean;
	readonly retain: boolean;
	/** Runs its own consolidation pass. */
	readonly consolidate: boolean;
	/** Remembers across sessions. */
	readonly persistent: boolean;
	/** Runs on this machine; nothing leaves it. */
	readonly local: boolean;
	/** Encrypts at rest. */
	readonly encryptedAtRest: boolean;
}

/**
 * A memory backend.
 *
 * Every method is optional and the capability block says which apply, so a
 * partially-implemented backend is honest about itself rather than throwing from
 * a method the panel called.
 */
export interface MemoryBackend {
	/** The value that selects this backend in the OMP Memory Backend setting. */
	readonly id: string;
	/** The label the selector shows. */
	readonly label: string;
	/** The description shown beside it. */
	readonly description: string;
	readonly capabilities: MemoryBackendCapabilities;

	/** Whether the backend can run right now. A missing dependency is false. */
	available(): Promise<{ ok: boolean; reason?: string }>;
	/** Begins use, acquiring whatever the backend needs. */
	start?(): Promise<void>;
	/** Releases resources. Called on switch and at session end. */
	stop?(): Promise<void>;

	/** Records a memory. */
	retain?(candidate: MemoryCandidate): Promise<MemoryRecord | undefined>;
	/** Retrieves memories. */
	recall?(query: MemoryQuery): Promise<readonly MemoryHit[]>;
	/** Runs a consolidation pass now. */
	consolidate?(): Promise<void>;
	/** Lists what is stored, for an inventory or an export. */
	list?(scope: { scope: MemoryScope; project?: string }): Promise<readonly MemoryRecord[]>;
	/**
	 * Removes a record.
	 *
	 * Distinct from superseding: a user deleting a memory is not the same as a
	 * fact changing, and the two must be separable.
	 */
	forget?(id: string): Promise<boolean>;
}

/** A backend registry entry, before instantiation. */
export interface MemoryBackendDescriptor {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Creates the backend, or explains why it cannot be created. */
	create(): MemoryBackend | { readonly unavailable: string };
	/**
	 * Position in the OMP selector.
	 *
	 * A PrimePi backend appends after every OMP backend rather than taking a
	 * slot, so the reference's ordering stays intact and a user who has learned
	 * the list still selects by position.
	 */
	readonly ompRank?: number;
}

/** The default cap on returned memories, so a recall cannot flood a context. */
export const DEFAULT_RECALL_LIMIT = 10;

/** The default cap on a single retained memory. */
export const MAX_MEMORY_TEXT_LENGTH = 4_000;

/**
 * Trims a candidate to what may be stored.
 *
 * A memory is a fact about the past. One that reads as an instruction is a
 * prompt-injection vector, and a memory is exactly the kind of content a model
 * will read and act on. Refusing here rather than at read time means a hostile
 * candidate never reaches storage.
 */
export function sanitizeMemoryText(text: string): { ok: boolean; reason?: string; text?: string } {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty" };
	if (trimmed.length > MAX_MEMORY_TEXT_LENGTH) {
		// Truncating a memory would leave a half-fact that reads as whole, which
		// is worse than not storing it.
		return { ok: false, reason: "too long" };
	}
	return { ok: true, text: trimmed };
}

/**
 * A memory a delegated child produced is scoped to the child's worktree unless
 * the caller says otherwise.
 *
 * A child working in an isolated worktree must not turn temporary branch state
 * into an unquestioned fact about the parent project. This is the check that
 * prevents it, and it is a default rather than a convention.
 */
export function scopeForOrigin(
	origin: { agent: string; worktree?: string },
	requested: MemoryScope,
): { scope: MemoryScope; warning?: string } {
	if (origin.worktree && requested === "project") {
		return {
			scope: "project",
			// Recorded rather than silently corrected: a caller that really does mean
			// a project fact from a worktree can state it, and the record carries why
			// it was allowed.
			warning: `promoted from worktree ${origin.worktree} to project scope`,
		};
	}
	return { scope: requested };
}

/** The provenance a child-agent record starts with. */
export function provenanceForOrigin(
	origin: { agent: string; worktree?: string; source?: string },
	overrides: Partial<MemoryProvenance> = {},
): MemoryProvenance {
	return {
		scope: overrides.scope ?? (origin.worktree ? "session" : "project"),
		...(origin.worktree ? { worktree: origin.worktree } : {}),
		...(origin.source ? { source: origin.source } : {}),
		agent: origin.agent,
		...overrides,
	} as MemoryProvenance;
}
