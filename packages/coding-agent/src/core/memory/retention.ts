/**
 * Controlled retention: what gets remembered, and what must not.
 *
 * ## The pipeline
 *
 * ```
 * work event
 *   -> candidate extraction   (what is even a fact?)
 *   -> classification         (what kind of fact?)
 *   -> validation             (may it be stored at all?)
 *   -> deduplication          (do we already know this?)
 *   -> retention              (hand it to whichever backend is selected)
 *   -> persistent store
 * ```
 *
 * and the reverse, for recall:
 *
 * ```
 * stored memory -> relevant query -> bounded hits -> planning/task context
 * ```
 *
 * ## Backend-neutral by construction
 *
 * Nothing here knows what a backend is. The service holds a `MemoryBackend` and
 * asks it to retain and recall; the IAI adapter, the local store and anything
 * ported later are interchangeable behind that interface. There is deliberately
 * no IAI-shaped branch anywhere in this file, because a generic memory service
 * that quietly assumes its most complex backend is the one that will rot first.
 *
 * ## What is deliberately not stored
 *
 * Transcripts, by default. A transcript is not a fact; it is the input to
 * looking for facts. Storing one would put every password, every half-finished
 * thought and every retracted claim into permanent recall. What is stored is the
 * extracted fact, and {@link RetentionPolicy.storeTranscripts} must be set
 * deliberately to change that.
 *
 * ## Current state always wins
 *
 * A memory is a claim about the past. A repository is a claim about the present.
 * When they disagree, the repository is right, and the caller is told so via
 * {@link RecallResult.staleConflicts} rather than being handed a stale fact that
 * reads as current. This is the single most important property in this file and
 * the one most likely to be broken by a well-meaning later change.
 */

import {
	DEFAULT_RECALL_LIMIT,
	MAX_MEMORY_TEXT_LENGTH,
	type MemoryBackend,
	type MemoryCandidate,
	type MemoryHit,
	type MemoryKind,
	type MemoryQuery,
	type MemoryRecord,
	type MemoryScope,
	sanitizeMemoryText,
} from "./backend.ts";
import { sanitizeStoredMemoryText } from "./redact.ts";

/** One thing that happened, before any judgement about it. */
export interface WorkEvent {
	/** What kind of work produced this. */
	readonly type: "task-completed" | "user-stated" | "review" | "test-run" | "plan" | "edit";
	/** The text a human or agent produced. Never a whole transcript. */
	readonly text: string;
	/** Who produced it. */
	readonly origin: { readonly agent: string; readonly worktree?: string; readonly source?: string };
	readonly sessionId?: string;
	readonly taskId?: string;
	/** Project identity, for project scope. */
	readonly project?: string;
	/** What backs it: a test result, a command output, a diff. */
	readonly evidence?: string;
	readonly at?: number;
}

/** A candidate, with the reason it is being considered. */
export interface ExtractedCandidate {
	readonly kind: MemoryKind;
	readonly text: string;
	readonly origin: WorkEvent["origin"];
	readonly scope: MemoryScope;
	readonly evidence?: string;
	readonly confidence: number;
	/** Why the extractor believes this is a fact worth keeping. */
	readonly reason: string;
}

/** Why a candidate did not survive. Reported, never silently dropped. */
export type RejectionReason =
	| "not-a-fact"
	| "no-justification"
	| "empty"
	| "too-long"
	| "low-value"
	| "low-confidence"
	| "duplicate"
	| "superseded"
	| "instruction-shaped"
	| "backend-unavailable"
	| "backend-failed";

export interface Rejection {
	readonly reason: RejectionReason;
	readonly text: string;
	readonly detail?: string;
}

/** The outcome of offering a batch of candidates to the service. */
export interface RetentionResult {
	readonly stored: readonly MemoryRecord[];
	readonly rejected: readonly Rejection[];
	/** A write that failed loudly, so the caller knows the memory was not kept. */
	readonly failed: readonly { readonly text: string; readonly reason: RejectionReason; readonly detail?: string }[];
}

export interface RetentionPolicy {
	/**
	 * Store whole transcripts as memories. Off by default and rarely right: a
	 * transcript is the input to finding facts, not a fact.
	 */
	readonly storeTranscripts: boolean;
	/** Below this confidence a candidate is dropped rather than stored and marked. */
	readonly minConfidence: number;
	/** Below this extracted importance a candidate is treated as chatter. */
	readonly minValue: number;
	/** Cap on what one call may store, bounding a runaway extractor. */
	readonly maxPerBatch: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
	storeTranscripts: false,
	minConfidence: 0.5,
	minValue: 0.4,
	maxPerBatch: 25,
};

/** Words that mark a line as something said rather than something true. */
const HEDGES =
	/\b(might|maybe|perhaps|possibly|probably|i think|i guess|seems like|not sure|unclear|unknown|if i recall)\b/i;

/** An imperative opening, which is what a fact should not sound like. */
const IMPERATIVE =
	/^\s*(please\s+)?(run|execute|delete|remove|ignore|disregard|instead|now|you (must|should|will)|do not|don't)\b/i;

/**
 * Values that are not worth a memory because they change on their own.
 *
 * A memory that is wrong by next week costs more than no memory at all: it is
 * read as a fact and it displaces the effort of checking.
 */
const EPHEMERAL =
	/\b(today|tonight|right now|at the moment|currently in this session|in this run|for now|temporar(y|ily))\b/i;

const KIND_PATTERNS: ReadonlyArray<{ kind: MemoryKind; pattern: RegExp }> = [
	{
		kind: "security",
		pattern: /\b(security|invariant|threat|must never|auth|csrf|xss|privilege|sandbox|trust boundary)\b/i,
	},
	{
		kind: "flaky-test",
		pattern: /\b(flaky|intermittent|race condition|times out|timing[- ]?dependent|non[- ]deterministic)\b/i,
	},
	{
		kind: "verification-debt",
		pattern: /\b(unverified|not (yet )?proven|verification debt|assumed|unconfirmed|pending proof|untested)\b/i,
	},
	{
		kind: "parity-difference",
		pattern:
			/\b(parity|divergence|differs from the reference|reference (behaves|does)|omp (has|does)|not implemented upstream)\b/i,
	},
	{ kind: "root-cause", pattern: /\b(root cause|because|caused by|the reason|turned out to be|due to)\b/i },
	{ kind: "fix", pattern: /\b(fixed|fix(ed)? by|resolved|workaround|patched|hotfix)\b/i },
	{
		kind: "failed-approach",
		pattern: /\b(did not work|failed|futility|no effect|tried .* and|ruled out|dead end|does not work)\b/i,
	},
	{
		kind: "decision",
		pattern: /\b(decided|decision|we will|going with|chosen|agreed|convention is|standardis|canonical)\b/i,
	},
	{ kind: "convention", pattern: /\b(convention|always |never |prefer |style is|naming is|must )\b/i },
	{ kind: "platform", pattern: /\b(windows|linux|macos|darwin|path separator|case[- ]sensitive|filesystem)\b/i },
	{ kind: "procedure", pattern: /\b(workflow|procedure|steps to|to reproduce|run .* then|checklist)\b/i },
];
/**
 * Pure evaluative language, with no factual claim attached.
 *
 * A memory that only says a thing is good or bad gives a later session nothing
 * to check. It reads as a conclusion without an argument, and the most expensive
 * kind of stale memory is one that was never a fact at all. A line carrying any
 * factual anchor - a component, a behaviour, a quantity - passes regardless, so
 * "the cooldown is elegant" is kept and "this is elegant" is not.
 */
const SUBJECTIVE =
	/\b(elegant|clean|nice|beautiful|ugly|good|bad|great|terrible|awful|excellent|poor|simple|obvious|trivial)\b/i;

/**
 * Something in the line that can be checked against the repository later.
 *
 * Deliberately broad. The bar is not "is this true" - Pi cannot know that - but
 * "does this name something a later session could go and verify", which is what
 * separates a fact from an evaluation.
 */
const FACTUAL_ANCHOR =
	/\b(file|function|method|class|module|package|script|test|build|flag|option|setting|config|command|error|exception|process|server|client|api|endpoint|schema|column|table|index|cache|queue|worker|thread|process|version|branch|commit|module|path|line|variable|constant|type|interface|enum|field|value|count|limit|timeout|size|rate|threshold|percentage)\b|[\w./-]+\.(ts|js|py|rs|json|toml|ya?ml|md|sh)\b|\d/;

/**
 * Whether a line states something checkable rather than musing about it.
 *
 * The bar is deliberately low on form and high on justification: a memory is
 * worth keeping when something backs it, not when it sounds confident.
 */
export function isWorthRemembering(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 12) return false;
	// A question is not a fact, and neither is a pure opinion about the future.
	if (trimmed.endsWith("?")) return false;
	if (HEDGES.test(trimmed)) return false;
	if (EPHEMERAL.test(trimmed)) return false;
	// An evaluative line with nothing to check is not a fact at all. A line that
	// mixes evaluation with a checkable claim is kept, because the claim is worth
	// having and discarding the whole line would lose it.
	if (SUBJECTIVE.test(trimmed) && !FACTUAL_ANCHOR.test(trimmed)) return false;
	return true;
}

/**
 * Assigns a kind, by pattern, most specific first.
 *
 * The ordering is the specificity ordering, not the list order: a line about a
 * security invariant that also says "because" is a security memory, and filing it
 * as a root cause would lose the thing that makes it binding.
 */
export function classifyMemory(text: string): MemoryKind {
	for (const { kind, pattern } of KIND_PATTERNS) {
		if (pattern.test(text)) return kind;
	}
	return "decision";
}

/** Normalised form for near-duplicate comparison. */
function fingerprint(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether two memories say the same thing.
 *
 * Exact match on a normalised hash catches the common case. The word-set overlap
 * catches the case that matters more: the same fact reworded. Two memories that
 * share every significant word and differ only in filler are one memory, and
 * storing both means the older one can be recalled as if it were a separate
 * piece of evidence.
 */
export function isSameFact(a: string, b: string): boolean {
	const left = fingerprint(a);
	const right = fingerprint(b);
	if (left === right) return true;
	const leftWords = new Set(left.split(" ").filter((word) => word.length > 3));
	const rightWords = new Set(right.split(" ").filter((word) => word.length > 3));
	if (leftWords.size === 0 || rightWords.size === 0) return false;
	let shared = 0;
	for (const word of leftWords) if (rightWords.has(word)) shared++;
	const smaller = Math.min(leftWords.size, rightWords.size);
	return smaller > 0 && shared / smaller >= 0.85;
}

/**
 * Extracts candidate facts from a work event.
 *
 * Deliberately conservative. A missed fact costs one more look at the
 * repository; a spurious one costs a stale claim in every later session. The
 * extractor does not summarise, and it never returns a whole transcript: it
 * returns lines that stand as facts, with the justification attached.
 */
export function extractCandidates(
	event: WorkEvent,
	policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): ExtractedCandidate[] {
	const raw = event.text ?? "";
	// A transcript is stored whole only if the caller deliberately asked, and even
	// then it is truncated to what a memory may hold.
	const lines = policy.storeTranscripts ? [raw.slice(0, MAX_MEMORY_TEXT_LENGTH)] : raw.split(/\r?\n/);

	const candidates: ExtractedCandidate[] = [];
	for (const line of lines) {
		const text = line.trim();
		if (text.length === 0) continue;
		if (isWorthRemembering(text)) {
			candidates.push({
				kind: classifyMemory(text),
				text,
				origin: event.origin,
				scope: event.origin.worktree ? "session" : "project",
				...(event.evidence ? { evidence: event.evidence } : {}),
				confidence: confidenceFor(event, text),
				reason: `extracted from a ${event.type} event`,
			});
		} else {
			// The rejection is recorded by the caller so that a summary of what was
			// considered and dropped is available for debugging a too-quiet pipeline.
			candidates.push({
				kind: classifyMemory(text),
				text,
				origin: event.origin,
				scope: "session",
				confidence: 0,
				reason: "not a fact",
			});
		}
	}
	return candidates;
}

/**
 * How much to trust a candidate, from what produced it and whether it is backed.
 *
 * A user statement is the strongest signal available, because a human asserting
 * a project fact outranks anything Pi inferred. An unbacked inference from a
 * plan is weak, and the threshold drops it.
 */
function confidenceFor(event: WorkEvent, text: string): number {
	let confidence = 0.5;
	if (event.type === "user-stated") confidence = 0.9;
	else if (event.type === "test-run" || event.type === "review") confidence = 0.75;
	else if (event.type === "edit" || event.type === "task-completed") confidence = 0.6;
	else if (event.type === "plan") confidence = 0.45;
	// Something that backs it is worth more than something merely asserted.
	if (event.evidence) confidence += 0.1;
	if (HEDGES.test(text)) confidence -= 0.2;
	return Math.max(0, Math.min(1, confidence));
}

/** A memory the repository contradicts, with what the repository says. */
export interface StaleConflict {
	readonly memory: MemoryRecord;
	/** What the current state shows. The caller reports this; Pi never edits. */
	readonly currentEvidence: string;
}

/** The bounded result of one recall. */
export interface RecallResult {
	readonly hits: readonly MemoryHit[];
	/** Memories that are superseded or that the current state contradicts. */
	readonly staleConflicts: readonly StaleConflict[];
	/** Set when the backend could not answer. A recall that fails is not empty. */
	readonly unavailable?: string;
	/** True when the pipeline was cut short, e.g. the cap was reached. */
	readonly truncated: boolean;
}

/** What the caller knows about the present, used to check memories against it. */
export interface CurrentState {
	/** A fact the current repository contradicts, as a short description. */
	readonly contradicts?: (record: MemoryRecord) => string | undefined;
}

/**
 * The backend-neutral memory service.
 *
 * One instance per session. It owns the rules; the backend owns the storage.
 */
export class MemoryService {
	readonly #backend: MemoryBackend;
	readonly #policy: RetentionPolicy;
	readonly #records = new Map<string, MemoryRecord>();

	constructor(backend: MemoryBackend, policy: Partial<RetentionPolicy> = {}) {
		this.#backend = backend;
		this.#policy = { ...DEFAULT_RETENTION_POLICY, ...policy };
	}

	get backendId(): string {
		return this.#backend.id;
	}

	get policy(): RetentionPolicy {
		return this.#policy;
	}

	/**
	 * Runs the full pipeline over one work event.
	 *
	 * Returns what was stored, what was rejected and why, and what failed. The
	 * rejection list is the point: a memory pipeline that silently drops half its
	 * candidates cannot be debugged, and a user cannot tell whether it is too
	 * eager or broken.
	 */
	async retainEvent(event: WorkEvent): Promise<RetentionResult> {
		const candidates = extractCandidates(event, this.#policy);
		const stored: MemoryRecord[] = [];
		const rejected: Rejection[] = [];
		const failed: { text: string; reason: RejectionReason; detail?: string }[] = [];

		let budget = this.#policy.maxPerBatch;
		for (const candidate of candidates) {
			if (budget <= 0) {
				rejected.push({ reason: "low-value", text: candidate.text, detail: "batch cap reached" });
				continue;
			}

			// Extraction marks a non-fact with zero confidence; reject it here so the
			// reason is specific rather than "low confidence" for every such line.
			if (candidate.confidence === 0) {
				rejected.push({ reason: "not-a-fact", text: candidate.text });
				continue;
			}
			if (candidate.confidence < this.#policy.minConfidence) {
				rejected.push({ reason: "low-confidence", text: candidate.text, detail: candidate.reason });
				continue;
			}

			const outcome = await this.#retainOne(candidate, event);
			if (outcome.ok) {
				stored.push(outcome.record);
				budget--;
			} else if (outcome.reason === "backend-unavailable" || outcome.reason === "backend-failed") {
				failed.push({
					text: candidate.text,
					reason: outcome.reason,
					...(outcome.detail ? { detail: outcome.detail } : {}),
				});
			} else {
				rejected.push({
					reason: outcome.reason,
					text: candidate.text,
					...(outcome.detail ? { detail: outcome.detail } : {}),
				});
			}
		}

		return { stored, rejected, failed };
	}

	async #retainOne(
		candidate: ExtractedCandidate,
		event: WorkEvent,
	): Promise<{ ok: true; record: MemoryRecord } | { ok: false; reason: RejectionReason; detail?: string }> {
		// Validation. A memory that reads as an instruction is a prompt-injection
		// vector, because memory is replayed into a later prompt. Refusing here means
		// it never reaches storage.
		if (IMPERATIVE.test(candidate.text)) {
			return {
				ok: false as const,
				reason: "instruction-shaped",
				detail: "reads as an instruction rather than a fact",
			};
		}

		// Sanitization runs before the length check so the stored form is what was
		// measured: stripping delimiters can shorten a line past the cap.
		const text = sanitizeStoredMemoryText(candidate.text);
		const sanitized = sanitizeMemoryText(text);
		if (!sanitized.ok) {
			return {
				ok: false as const,
				reason: sanitized.reason === "empty" ? "empty" : "too-long",
				detail: sanitized.reason,
			};
		}

		if (this.#isDuplicate(sanitized.text!)) {
			return { ok: false as const, reason: "duplicate", detail: "an equivalent memory is already stored" };
		}

		if (!this.#backend.capabilities.retain || !this.#backend.retain) {
			return { ok: false as const, reason: "backend-unavailable", detail: `${this.#backend.id} cannot retain` };
		}

		// Readiness is checked before the write, not after: a write into a backend
		// that is down fails obscurely, whereas an explicit check says why.
		const available = await this.#backend.available();
		if (!available.ok) {
			return {
				ok: false as const,
				reason: "backend-unavailable",
				detail: available.reason ?? "the backend is not available",
			};
		}

		const memoryCandidate: MemoryCandidate = {
			kind: candidate.kind,
			text: sanitized.text!,
			provenance: {
				scope: candidate.scope,
				...(event.project ? { project: event.project } : {}),
				...(event.sessionId ? { sessionId: event.sessionId } : {}),
				...(event.taskId ? { taskId: event.taskId } : {}),
				...(event.origin.worktree ? { worktree: event.origin.worktree } : {}),
				...(event.origin.source ? { source: event.origin.source } : {}),
				reason: candidate.reason,
				...(candidate.evidence ? { evidence: candidate.evidence } : {}),
				confidence: candidate.confidence,
			},
			...(candidate.evidence ? { evidence: candidate.evidence } : {}),
			confidence: candidate.confidence,
		};

		try {
			const record = await this.#backend.retain(memoryCandidate);
			if (!record) {
				// A backend that accepts the write but returns nothing has silently
				// dropped it, which is the failure mode this whole design guards.
				return {
					ok: false as const,
					reason: "backend-failed",
					detail: "the backend accepted the write and returned no record",
				};
			}
			this.#remember(record);
			return { ok: true as const, record };
		} catch (error) {
			return {
				ok: false as const,
				reason: "backend-failed",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
	}

	#isDuplicate(text: string): boolean {
		for (const record of this.#records.values()) {
			if (isSameFact(record.text, text)) return true;
		}
		return false;
	}

	#remember(record: MemoryRecord): void {
		this.#records.set(record.id, record);
	}

	/**
	 * Retrieves memories relevant to a cue, bounded, and checked against the present.
	 *
	 * The bound is not a performance detail. Recall feeds a context window, and an
	 * unbounded memory list would displace the task it is meant to inform.
	 */
	async recall(query: MemoryQuery, current: CurrentState = {}): Promise<RecallResult> {
		if (!this.#backend.capabilities.recall || !this.#backend.recall) {
			return { hits: [], staleConflicts: [], unavailable: `${this.#backend.id} cannot recall`, truncated: false };
		}
		const available = await this.#backend.available();
		if (!available.ok) {
			// Reported as unavailable rather than returned as empty, because "no
			// memories" and "the store is down" demand opposite responses.
			return {
				hits: [],
				staleConflicts: [],
				unavailable: available.reason ?? "the backend is not available",
				truncated: false,
			};
		}

		const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_RECALL_LIMIT, DEFAULT_RECALL_LIMIT));
		let hits: readonly MemoryHit[];
		try {
			hits = await this.#backend.recall({ ...query, limit });
		} catch (error) {
			return {
				hits: [],
				staleConflicts: [],
				unavailable: error instanceof Error ? error.message : String(error),
				truncated: false,
			};
		}

		const staleConflicts: StaleConflict[] = [];
		const live: MemoryHit[] = [];
		for (const hit of hits.slice(0, limit)) {
			// A superseded memory is never presented as current. It is returned in
			// the conflict list so a caller that wants the history can have it.
			if (hit.record.supersededBy) {
				staleConflicts.push({ memory: hit.record, currentEvidence: `superseded by ${hit.record.supersededBy}` });
				continue;
			}
			// The repository outranks the memory. A contradicted memory is reported
			// as a conflict and withheld, because the whole failure this guards is a
			// stale claim being read as a current fact.
			const contradiction = current.contradicts?.(hit.record);
			if (contradiction) {
				staleConflicts.push({ memory: hit.record, currentEvidence: contradiction });
				continue;
			}
			live.push(hit);
		}

		return { hits: live, staleConflicts, truncated: hits.length > limit };
	}
}
