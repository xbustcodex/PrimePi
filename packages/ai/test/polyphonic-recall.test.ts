import { describe, expect, it } from "vitest";
import {
	assembleContext,
	DIVERSITY_THRESHOLD,
	diversityRerank,
	type FusedResult,
	fuseByReciprocalRank,
	POLYPHONIC_VOICES,
	type PolyphonicVoice,
	RRF_K,
	type VoiceRanking,
	voiceSetSimilarity,
} from "../src/utils/polyphonic-recall.ts";

/**
 * Polyphonic recall.
 *
 * The property that matters is **agreement beats any single win**. Each voice
 * scores on its own scale, so the fusion uses only each voice's *ordering* - a
 * memory one voice loves is one opinion, and a memory four voices rank highly is
 * a convergence. Averaging the raw scores instead would let whichever voice has
 * the widest numeric range dominate, for reasons that have nothing to do with
 * the query.
 */

const hit = (memoryId: string, voice: PolyphonicVoice, metadata?: Record<string, unknown>) => ({
	memoryId,
	voice,
	metadata,
});

interface PartialRankings {
	[key: string]: { memoryId: string; voice: PolyphonicVoice; metadata?: Record<string, unknown> }[] | undefined;
}

const fuse = (input: PartialRankings) => {
	const map = new Map<PolyphonicVoice, VoiceRanking>();
	for (const [voice, hits] of Object.entries(input)) {
		if (hits) map.set(voice as PolyphonicVoice, hits);
	}
	return fuseByReciprocalRank(map);
};

const result = (memoryId: string, voices: PolyphonicVoice[], combinedScore = 1): FusedResult => ({
	memoryId,
	combinedScore,
	voiceScores: Object.fromEntries(voices.map((voice) => [voice, 0.01])),
	metadata: {},
});

describe("fusion uses rank, not score", () => {
	it("contributes 1/(k+rank) for each voice's ranking", () => {
		const fused = fuse({ vector: [hit("a", "vector")] });
		expect(fused.get("a")?.combinedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
	});

	it("rewards a memory several voices agree on over one that leads a single voice", () => {
		// This is the entire reason to run four voices.
		const fused = fuse({
			vector: [hit("solo", "vector"), hit("agreed", "vector")],
			graph: [hit("agreed", "graph"), hit("solo", "graph")],
			fact: [hit("agreed", "fact")],
			temporal: [hit("agreed", "temporal")],
		});
		const agreed = fused.get("agreed")?.combinedScore ?? 0;
		const solo = fused.get("solo")?.combinedScore ?? 0;
		expect(agreed).toBeGreaterThan(solo);
	});

	it("flattens the curve enough that agreement outweighs a single top hit", () => {
		// A rank-1 hit in one voice is 1/61. Four rank-10 hits is 4/70. With a small
		// constant one win would always beat convergence.
		expect(4 / (RRF_K + 10)).toBeGreaterThan(1 / (RRF_K + 1));
	});

	it("accumulates per-voice scores", () => {
		const fused = fuse({ vector: [hit("a", "vector")], graph: [hit("a", "graph")] });
		expect(fused.get("a")?.combinedScore).toBeCloseTo(2 / (RRF_K + 1), 10);
		expect(fused.get("a")?.voiceScores.vector).toBeGreaterThan(0);
		expect(fused.get("a")?.voiceScores.graph).toBeGreaterThan(0);
	});

	it("treats a voice returning nothing as degraded, not as failure", () => {
		const fused = fuse({ vector: [hit("a", "vector")], graph: [], fact: [] });
		expect(fused.size).toBe(1);
		expect(fused.get("a")?.combinedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
	});

	it("ranks reproducibly when a voice returns two identical hits", () => {
		// The tiebreak is on the id, not the incoming order, so the fused result does
		// not depend on how a voice happened to return its rows.
		const first = fuse({ vector: [hit("b", "vector"), hit("a", "vector")] });
		const second = fuse({ vector: [hit("a", "vector"), hit("b", "vector")] });
		expect(first.get("a")?.combinedScore).toBe(second.get("a")?.combinedScore);
	});
});

describe("metadata comes from the most specific voice", () => {
	it("lets a later voice describe a memory", () => {
		const fused = fuse({
			vector: [hit("a", "vector", { summary: "vague" })],
			fact: [hit("a", "fact", { detail: "specific" })],
		});
		expect(fused.get("a")?.metadata).toMatchObject({ summary: "vague", detail: "specific" });
	});

	it("survives a voice contributing no metadata", () => {
		const fused = fuse({ vector: [hit("a", "vector")] });
		expect(fused.get("a")?.metadata).toEqual({});
	});
});

describe("diversity is measured on voice overlap, not text", () => {
	it("reports identical voice sets as fully similar", () => {
		expect(voiceSetSimilarity(result("a", ["vector", "graph"]), result("b", ["vector", "graph"]))).toBe(1);
	});

	it("reports disjoint voice sets as unrelated", () => {
		// Two memories recalled through disjoint voices may share wording and still
		// answer different parts of the query.
		expect(voiceSetSimilarity(result("a", ["vector", "graph"]), result("b", ["fact", "temporal"]))).toBe(0);
	});

	it("cannot compare a result that no voice found", () => {
		// Reporting it as maximally similar would suppress it.
		expect(voiceSetSimilarity(result("a", []), result("b", ["vector"]))).toBe(0);
	});

	it("keeps one entry from a cluster of near-identical results", () => {
		const selected = diversityRerank(
			[result("a", [...POLYPHONIC_VOICES]), result("b", [...POLYPHONIC_VOICES]), result("c", ["vector"])],
			10,
		).map((entry) => entry.memoryId);
		expect(selected).toContain("a");
		expect(selected).not.toContain("b");
		// A disjoint voice set is a different answer, not a duplicate.
		expect(selected).toContain("c");
	});

	it("takes the highest scoring member of a cluster", () => {
		const selected = diversityRerank(
			[result("a", [...POLYPHONIC_VOICES], 0.01), result("b", [...POLYPHONIC_VOICES], 0.5)],
			1,
		);
		expect(selected.map((entry) => entry.memoryId)).toEqual(["b"]);
	});

	it("respects the ceiling even when everything is diverse", () => {
		const results = POLYPHONIC_VOICES.map((voice, index) => result(`m${index}`, [voice]));
		expect(diversityRerank(results, 2)).toHaveLength(2);
	});

	it("uses a threshold that is neither trivially low nor one", () => {
		expect(DIVERSITY_THRESHOLD).toBeGreaterThan(0.5);
		expect(DIVERSITY_THRESHOLD).toBeLessThan(1);
	});
});

describe("assembling context stops at the first item that does not fit", () => {
	const sized = (memoryId: string, chars: number): FusedResult => ({
		memoryId,
		combinedScore: 1,
		voiceScores: { vector: 0.01 },
		metadata: { body: "x".repeat(chars) },
	});

	it("fits results within the budget", () => {
		// The cost model is deliberately crude: an exact accounting would need the
		// rendered form, and this runs before rendering.
		expect(assembleContext([sized("a", 100), sized("b", 100)], 1000).map((entry) => entry.memoryId)).toEqual([
			"a",
			"b",
		]);
	});

	it("stops rather than skipping past an oversized result", () => {
		// A later result is no smaller, so continuing would only add cost without
		// adding content.
		expect(assembleContext([sized("a", 10_000), sized("b", 10)], 100)).toEqual([]);
	});

	it("returns nothing for a zero budget", () => {
		expect(assembleContext([sized("a", 10)], 0)).toEqual([]);
	});
});
