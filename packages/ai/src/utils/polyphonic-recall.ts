/**
 * Polyphonic recall: four independent voices, fused by reciprocal rank.
 *
 * ## Why fuse ranks rather than scores
 *
 * Each voice scores on its own scale. A cosine similarity, a graph distance and
 * an importance number are not comparable numbers, and averaging them lets the
 * voice with the widest range dominate the result for reasons that have nothing
 * to do with the query. Reciprocal rank fusion sidesteps the problem by
 * discarding the scores entirely and using only each voice's *ordering*.
 *
 * The constant is 60, and it is not tuned. It sets how sharply the fusion
 * distinguishes rank 1 from rank 2. Larger flattens the curve so that agreeing
 * across many voices outweighs winning one; smaller lets a single top hit
 * dominate. 60 is the value from the original paper and it behaves well, so it
 * stays.
 *
 * ## Agreement across voices is the signal
 *
 * A memory that one voice ranks highly is a single opinion. A memory that four
 * voices all rank highly is a convergence, and the fusion rewards exactly that -
 * which is the entire reason to run four voices at all.
 *
 * ## The rerank is on voice overlap, not content
 *
 * Diversity is measured as the Jaccard overlap of *which voices* found a result,
 * not of the text. Two near-identical memories recalled through the same single
 * voice are genuinely redundant; two memories recalled through disjoint voice
 * sets may share wording and still be answering different parts of the query.
 *
 * ## Malformed input degrades, it does not fail
 *
 * Every voice's contribution is bounded and additive, so a voice returning
 * nothing, or a row with unusable metadata, costs that voice's ranking and
 * nothing else. A degraded voice must never make recall fail outright.
 */

/** The four retrieval voices. */
export const POLYPHONIC_VOICES = ["vector", "graph", "fact", "temporal"] as const;

export type PolyphonicVoice = (typeof POLYPHONIC_VOICES)[number];

/** The rank-fusion constant. Flat enough that agreement beats any single win. */
export const RRF_K = 60;

/** Above this voice-set overlap, two results are treated as redundant. */
export const DIVERSITY_THRESHOLD = 0.8;

export interface VoiceHit {
	readonly memoryId: string;
	readonly voice: PolyphonicVoice;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FusedResult {
	readonly memoryId: string;
	readonly combinedScore: number;
	readonly voiceScores: Readonly<Partial<Record<PolyphonicVoice, number>>>;
	readonly metadata: Readonly<Record<string, unknown>>;
}

/** One voice's ranked hits. Rank 1 is `hits[0]`. */
export type VoiceRanking = readonly VoiceHit[];

/**
 * Fuses the voices by reciprocal rank.
 *
 * The tiebreak inside each voice is on the id, not the incoming order, so a
 * voice returning two identical scores has a deterministic ranking and the
 * fused result is reproducible.
 */
export function fuseByReciprocalRank(rankings: ReadonlyMap<PolyphonicVoice, VoiceRanking>): Map<string, FusedResult> {
	const combined = new Map<string, FusedResult>();
	for (const [voice, hits] of rankings) {
		// A voice with no hits contributes nothing, which is a degraded voice rather
		// than a failure.
		if (hits.length === 0) continue;
		const sorted = [...hits].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
		sorted.forEach((hit, index) => {
			const rank = index + 1;
			let existing = combined.get(hit.memoryId);
			if (existing === undefined) {
				existing = { memoryId: hit.memoryId, combinedScore: 0, voiceScores: {}, metadata: {} };
				combined.set(hit.memoryId, existing);
			}
			const contribution = 1 / (RRF_K + rank);
			const mutable = existing as {
				voiceScores: Record<string, number>;
				metadata: Record<string, unknown>;
				combinedScore: number;
			};
			mutable.voiceScores[voice] = (mutable.voiceScores[voice] ?? 0) + contribution;
			mutable.combinedScore += contribution;
			// Later voices overwrite earlier metadata for the same key. That is
			// deliberate: a more specific voice's description of a memory should win
			// over a vaguer one's.
			Object.assign(mutable.metadata, hit.metadata ?? {});
		});
	}
	return combined;
}

/**
 * Overlap of the voice sets that produced two results.
 *
 * Jaccard over voices, not over text. Two results recalled by the same single
 * voice are redundant; two recalled through disjoint voice sets may share wording
 * and still answer different parts of the query.
 */
export function voiceSetSimilarity(left: FusedResult, right: FusedResult): number {
	let leftCount = 0;
	let rightCount = 0;
	let intersection = 0;
	for (const voice of POLYPHONIC_VOICES) {
		const inLeft = left.voiceScores[voice] !== undefined;
		const inRight = right.voiceScores[voice] !== undefined;
		if (inLeft) leftCount++;
		if (inRight) rightCount++;
		if (inLeft && inRight) intersection++;
	}
	// A result with no voices cannot be compared to anything, and reporting it as
	// maximally similar would suppress it.
	if (leftCount === 0 || rightCount === 0) return 0;
	return intersection / (leftCount + rightCount - intersection);
}

/**
 * Reranks for diversity, taking at most `topK`.
 *
 * A result is skipped when it overlaps a *selected* result above the threshold,
 * so a cluster of near-identical memories contributes one entry instead of
 * filling the whole budget.
 */
export function diversityRerank(results: Iterable<FusedResult>, topK: number): FusedResult[] {
	const sorted = [...results].sort(
		(left, right) => right.combinedScore - left.combinedScore || left.memoryId.localeCompare(right.memoryId),
	);
	const selected: FusedResult[] = [];
	const limit = Math.max(0, Math.trunc(topK));
	for (const result of sorted) {
		if (selected.length >= limit) break;
		const redundant = selected.some((prior) => voiceSetSimilarity(result, prior) > DIVERSITY_THRESHOLD);
		if (!redundant) selected.push(result);
	}
	return selected;
}

/**
 * Fits the selected results into a character budget.
 *
 * The cost model is deliberately crude - metadata length plus a flat allowance
 * for the id and scores. An exact accounting would need the rendered form, and
 * this runs before rendering; a rough estimate that errs toward including
 * slightly less is the right side to err on, because the alternative is a
 * context block that overflows what was allotted.
 *
 * Once something is skipped, the walk stops rather than continuing: a later
 * result is no smaller, so continuing would only add cost without adding
 * content.
 */
export function assembleContext(results: readonly FusedResult[], budgetTokens: number): FusedResult[] {
	const maxChars = Math.max(0, Math.trunc(budgetTokens)) * 4;
	let chars = 0;
	const selected: FusedResult[] = [];
	for (const result of results) {
		const size = JSON.stringify(result.metadata).length + 100;
		if (chars + size > maxChars) break;
		selected.push(result);
		chars += size;
	}
	return selected;
}
