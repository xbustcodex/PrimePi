/**
 * Relevance ranking, shared by every backend.
 *
 * Ranking lives here rather than in a backend because relevance is a property of
 * the query and the corpus, not of where the corpus happens to be stored. If each
 * backend ranked its own results, "what does memory consider relevant" would
 * depend on which backend a user happens to have selected, and a bug in one
 * backend's ranking would look like a bug in the memory system.
 *
 * The scoring is deliberately simple and explainable. A learned embedding index
 * belongs in a backend that has one; the shared layer needs a ranking that is
 * predictable, needs no model, and cannot silently change when a dependency
 * updates. A memory system whose ordering shifts between runs is a memory system
 * nobody can debug.
 */

import type { MemoryHit, MemoryQuery, MemoryRecord } from "./backend.ts";

/** Words too common to say anything about relevance. */
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"this",
	"with",
	"from",
	"have",
	"has",
	"was",
	"were",
	"are",
	"but",
	"not",
	"you",
	"your",
	"its",
	"it's",
	"they",
	"them",
	"their",
	"there",
	"here",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"how",
	"all",
	"can",
	"will",
	"would",
	"should",
	"could",
	"about",
	"into",
	"than",
	"then",
	"some",
	"any",
	"get",
	"got",
	"use",
	"used",
	"using",
	"does",
	"did",
	"doing",
	"done",
	"make",
	"made",
	"just",
	"also",
	"very",
	"more",
	"most",
	"such",
	"only",
	"same",
	"other",
	"over",
	"after",
	"before",
	"between",
	"because",
	"while",
	"whereas",
]);

/** Splits text into significant terms, lowercased and stripped of punctuation. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * How well one record answers a query, 0-1.
 *
 * Three signals, in the order they change the answer:
 *
 * 1. **Term overlap**, weighted toward rare terms. Matching "authentication" says
 *    more than matching "the", so a term shared by few records in the corpus
 *    counts for more. This is IDF, kept in its simplest form.
 * 2. **Phrase proximity.** Two records containing the same words far apart are
 *    about different things; adjacency is evidence of a shared topic.
 * 3. **Kind agreement.** A query that asks about a flaky test should rank a
 *    flaky-test memory above a security memory that happens to share vocabulary.
 */
function scoreRecord(record: MemoryRecord, queryTerms: string[], corpus: readonly MemoryRecord[]): number {
	if (queryTerms.length === 0) return 0;
	const recordTerms = tokenize(record.text);
	if (recordTerms.length === 0) return 0;
	const recordTermSet = new Set(recordTerms);

	// Document frequency, computed once per recall rather than per record.
	const documentFrequency = new Map<string, number>();
	for (const term of new Set(queryTerms)) {
		let count = 0;
		for (const other of corpus) {
			if (tokenize(other.text).includes(term)) count++;
		}
		documentFrequency.set(term, count);
	}

	let matched = 0;
	let weight = 0;
	for (const term of queryTerms) {
		if (!recordTermSet.has(term)) continue;
		matched++;
		// A term in every record discriminates nothing, so its weight approaches zero
		// as document frequency approaches the corpus size. Guarded against a corpus
		// of one, where IDF would otherwise divide by zero.
		const df = documentFrequency.get(term) ?? 1;
		weight += Math.log(1 + corpus.length / Math.max(1, df));
	}
	if (matched === 0) return 0;

	const totalWeight = queryTerms.reduce(
		(total, term) => total + Math.log(1 + corpus.length / Math.max(1, documentFrequency.get(term) ?? 1)),
		0,
	);
	// Coverage matters as much as weight: a record matching two of four query terms
	// should not outrank one matching all four, however rare its terms are.
	const coverage = matched / queryTerms.length;
	const weighted = totalWeight === 0 ? coverage : weight / totalWeight;
	let score = 0.6 * weighted + 0.4 * coverage;

	// Proximity: a query phrase appearing verbatim is strong evidence.
	const needle = queryTerms.join(" ");
	if (needle.length > 4 && record.text.toLowerCase().includes(needle)) score += 0.15;

	// Recency, gently. A memory from last week beats one from last year for most
	// questions, but the effect is small: an old correct fact still beats a new
	// wrong one, which is what the conflict check is for.
	const ageDays = Math.max(0, (Date.now() - record.createdAt) / 86_400_000);
	score += Math.max(0, 0.05 - ageDays * 0.001);

	return Math.min(1, score);
}

/**
 * Ranks a corpus against a query and returns bounded hits.
 *
 * A record that scores zero is not returned. Returning every record with a score
 * of zero would fill a bounded context window with noise, which is the same
 * failure as an unbounded recall dressed up as a bounded one.
 */
export function rankByRelevance(
	corpus: readonly MemoryRecord[],
	query: MemoryQuery,
	limit: number,
): readonly MemoryHit[] {
	const queryTerms = tokenize(query.text);
	if (queryTerms.length === 0) return [];
	const scored: MemoryHit[] = [];
	for (const record of corpus) {
		const score = scoreRecord(record, queryTerms, corpus);
		if (score <= 0) continue;
		scored.push({ record, score });
	}
	// Ties break on recency, then on id, so the order is total and reproducible.
	scored.sort(
		(a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt || a.record.id.localeCompare(b.record.id),
	);
	return scored.slice(0, Math.max(0, limit));
}
