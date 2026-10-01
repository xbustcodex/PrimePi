/**
 * The advisor emission guard: the single admission authority for advice.
 *
 * ## One authority, and it must be honest about refusals
 *
 * Every note an advisor model emits passes through `admit`. The decision carries
 * a truthful reason that the tool surfaces verbatim, because the two failure
 * modes are both corrosive and neither is visible from the transcript:
 *
 * - A rejected note described as recorded teaches the model that suppression
 *   does not happen, so it keeps emitting and keeps being dropped.
 * - A rate-limited note mislabelled a duplicate sends the operator looking for a
 *   dedupe bug that does not exist.
 *
 * So `rate-limit` and `duplicate` are different reasons, and the caller never
 * re-infers policy from its own state.
 *
 * ## A blocker is never budgeted
 *
 * `blocker` means "the primary is about to do something wrong". Dropping one to
 * respect a per-update budget would let a model that has run out of nits also
 * run out of the ability to report an actual problem, so blockers bypass the
 * budget entirely.
 *
 * ## A routed slot is charged forever
 *
 * Once a note reaches the primary its slot stays spent. Delivery cannot be
 * retracted, so freeing the slot would let the update deliver more than the
 * budget allows. Only *still-pending* notes can be displaced.
 *
 * ## Escalation is in place, never a second slot
 *
 * Re-raising the same text at a higher severity upgrades its existing slot. A
 * second slot would let one problem be counted twice against the budget and
 * could displace a genuinely different note.
 *
 * ## Silence is the correct expression of "no concerns"
 *
 * A watcher model asked to report findings will emit "no issues", "looks good",
 * "on track" and similar, and every one of those costs a turn of primary context
 * to say nothing. The suppression list is matched against the *whole* normalized
 * note, which is what keeps a genuine blocker containing the word "stop" — the
 * failure the list exists to avoid — while dropping a bare "stop".
 */

/** Maximum non-blocker notes allowed per update across all configurations. */
export const ADVISOR_MAX_BUDGET_PER_UPDATE = 32;

/** Default non-blocker notes allowed per update. */
export const ADVISOR_DEFAULT_BUDGET_PER_UPDATE = 4;

/**
 * Bounds the dedupe history.
 *
 * A long session would otherwise grow the set without limit; the observed
 * pathological session had 92 unique notes, so 4096 is generous while staying
 * small.
 */
export const ADVISOR_HISTORY_CAPACITY = 4096;

/** Why a note was suppressed. Surfaced verbatim in the acknowledgment. */
export type AdvisorSuppressionReason = "empty" | "noise" | "duplicate" | "rate-limit";

export interface AdvisorAdmission {
	readonly accepted: boolean;
	/** Set only when `accepted` is false. */
	readonly reason?: AdvisorSuppressionReason;
	/**
	 * Normalized key of a still-pending note from the SAME update that this
	 * admission displaced. The caller must drop it from its pending backlog. Only
	 * pending notes are ever displaced, because a delivery cannot be retracted.
	 */
	readonly displacedKey?: string;
}

/** Severity, ordered. Higher is more urgent. */
export const ADVISOR_SEVERITIES = ["nit", "concern", "blocker"] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

const SEVERITY_RANK: Readonly<Record<AdvisorSeverity, number>> = { nit: 1, concern: 2, blocker: 3 };

/** Rank for a severity name; an unknown name is treated as a nit, the weakest. */
export function advisorSeverityRank(severity: unknown): number {
	return typeof severity === "string" && severity in SEVERITY_RANK
		? SEVERITY_RANK[severity as AdvisorSeverity]
		: SEVERITY_RANK.nit;
}

/**
 * Case-insensitive, punctuation-folded normalization.
 *
 * Every run of non-letter/non-digit collapses to a single space, so `"Stop."`,
 * `"*Stop*"` and `"  stop  "` all key to `stop`, and `"No issue; continue."` keys
 * to `"no issue continue"`. NFKC first so a fullwidth or compatibility character
 * folds before the punctuation pass rather than surviving it.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Normalized phrases that carry no actionable content.
 *
 * Matched against the **whole** normalized note, which is what separates a bare
 * `"stop"` from a blocker like `"Stop: 'await' missing on writeStream.end() will
 * lose buffered writes."` — that one normalizes to something no key here equals,
 * so it survives. A substring match would suppress the real finding.
 */
const SUPPRESSED: ReadonlySet<string> = new Set([
	// Self-stop noise: telling the agent to stop without a reason is useless.
	"stop",
	"stop here",
	"stop now",
	"halt",
	"abort",
	// Completion self-talk: the task is already done.
	"done",
	"task done",
	"task complete",
	"complete",
	"finished",
	"ok",
	"okay",
	"ok done",
	// Silence is the correct expression of "no concerns", but costs a turn to say.
	"no issue",
	"no issues",
	"no issue continue",
	"no concerns",
	"no concern",
	"nothing to add",
	"nothing to flag",
	"nothing to report",
	"no notes",
	"no further input",
	"no further input needed",
	"no further input required",
	"no further watcher input",
	"no further watcher input needed",
	"no further advice",
	"no further advice needed",
	// Endorsements, which are equivalent to silence.
	"lgtm",
	"looks good",
	"all good",
	"agent is on track",
	"agent on track",
	"on track",
	"continue",
	"carry on",
]);

interface Slot {
	key: string;
	rank: number;
	pending: boolean;
}

export class AdvisorEmissionGuard {
	/** Normalized key to the highest rank ever admitted for it. */
	readonly #seen = new Map<string, number>();
	/** Slots charged against this update's budget. */
	#slots: Slot[] = [];
	readonly #budgetPerUpdate: number;
	readonly #historyCapacity: number;

	constructor(options: { budgetPerUpdate?: number; historyCapacity?: number } = {}) {
		const requested = options.budgetPerUpdate ?? ADVISOR_DEFAULT_BUDGET_PER_UPDATE;
		// A configured budget may only lower the ceiling. Raising it would run the
		// advisor in a mode nobody tested, and 32 is already generous.
		this.#budgetPerUpdate = Math.max(0, Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.trunc(requested)));
		this.#historyCapacity = Math.max(1, Math.trunc(options.historyCapacity ?? ADVISOR_HISTORY_CAPACITY));
	}

	/** Slots currently charged. */
	get slotCount(): number {
		return this.#slots.length;
	}

	/** The effective budget, after clamping. */
	get budget(): number {
		return this.#budgetPerUpdate;
	}

	/** Clears the budget and the dedupe history, for a fresh conversation. */
	reset(): void {
		this.#seen.clear();
		this.#slots = [];
	}

	/**
	 * Records a note's rank as pending without charging a slot.
	 *
	 * Used when a still-queued note is escalated: the escalation is an admission
	 * decision, so the dedupe rank has to move with it or an equal-rank repeat
	 * would be admitted as new.
	 */
	escalatePending(note: string, rank: number): void {
		const key = normalizeAdvisorNote(note);
		this.#recordRank(key, rank);
		// The slot's rank has to move with the dedupe rank, not just the seen-map.
		// `admit` displaces by comparing the incoming rank against the *slot's* rank,
		// so a note escalated from nit to concern and left at nit could be displaced
		// by another nit — exactly what the escalation exists to prevent.
		//
		// Verified before this change: with a budget of one, a nit admitted and then
		// escalated to concern was displaced by an incoming concern, because the slot
		// still carried rank 1.
		//
		// The slot is not created here. `escalatePending` is documented as not charging
		// a slot, so an escalation for a note that never took one has nothing to
		// update — only the dedupe rank moves.
		const slot = this.#slots.find((entry) => entry.key === key);
		if (slot) slot.rank = rank;
	}

	/**
	 * Marks a pending note as delivered.
	 *
	 * Its slot stays charged: the note already reached the primary and delivery
	 * cannot be retracted, so freeing the slot would let this update deliver more
	 * than its budget.
	 */
	markRouted(note: string): void {
		const slot = this.#slots.find((entry) => entry.key === normalizeAdvisorNote(note));
		if (slot) slot.pending = false;
	}

	/**
	 * Decides whether one note may reach the primary.
	 *
	 * Order matters: empty, then noise, then duplicate. A duplicate that is also
	 * noise is reported as noise, because that is the more specific truth about
	 * why it was dropped and the more useful one to act on.
	 */
	admit(note: string, options: { rank: number; pending: boolean }): AdvisorAdmission {
		const key = normalizeAdvisorNote(note);
		if (key.length === 0) return { accepted: false, reason: "empty" };
		if (SUPPRESSED.has(key)) return { accepted: false, reason: "noise" };
		const { rank, pending } = options;
		// A strictly-higher rank is a real escalation and is admitted; an equal or
		// lower one is the same note again.
		if (rank <= (this.#seen.get(key) ?? 0)) return { accepted: false, reason: "duplicate" };

		const ownSlot = this.#slots.find((slot) => slot.key === key);
		let displacedKey: string | undefined;

		if (rank >= SEVERITY_RANK.blocker) {
			// Blockers are never dropped to the budget: a model out of nits must
			// still be able to report an actual problem. A pending blocker releases
			// its reservation because it now routes live and will never flush.
			if (ownSlot?.pending) this.#slots.splice(this.#slots.indexOf(ownSlot), 1);
		} else if (ownSlot !== undefined) {
			// Same-update escalation of an already-admitted note: upgrade the slot
			// rather than charging a second one for the same text, which would let one
			// problem count twice and displace a genuinely different note.
			ownSlot.rank = rank;
		} else if (this.#slots.length < this.#budgetPerUpdate) {
			this.#slots.push({ key, rank, pending });
		} else {
			// Budget full. A strictly-higher rank displaces the lowest-rank still-pending
			// slot; same or lower rank, or a budget spent entirely on routed notes, is
			// a rate limit.
			let lowest = -1;
			for (let index = 0; index < this.#slots.length; index++) {
				const slot = this.#slots[index]!;
				if (!slot.pending) continue;
				if (lowest === -1 || slot.rank < this.#slots[lowest]!.rank) lowest = index;
			}
			if (lowest === -1 || rank <= this.#slots[lowest]!.rank) {
				return { accepted: false, reason: "rate-limit" };
			}
			displacedKey = this.#slots[lowest]!.key;
			this.#slots[lowest] = { key, rank, pending };
		}

		this.#recordRank(key, rank);
		return displacedKey === undefined ? { accepted: true } : { accepted: true, displacedKey };
	}

	#recordRank(key: string, rank: number): void {
		if (key.length === 0) return;
		this.#seen.set(key, rank);
		// Bounded so a long session cannot grow the set without limit. Evicting the
		// oldest is safe: a forgotten note can be re-admitted, which costs a turn,
		// whereas an unbounded set is a leak.
		while (this.#seen.size > this.#historyCapacity) {
			const oldest = this.#seen.keys().next();
			if (oldest.done) break;
			this.#seen.delete(oldest.value);
		}
	}
}
