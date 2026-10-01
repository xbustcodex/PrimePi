/**
 * Edit matching: locating a model's `oldText` in a file.
 *
 * ## What this replaces
 *
 * Pi's `fuzzyFindText` normalizes the content and the target and then does
 * `indexOf`. Normalization covers trailing whitespace, smart quotes, unicode
 * dashes and exotic spaces — so a CRLF file, a reindented block, or a curly-quoted
 * string all match. What it does *not* cover is a line that differs in content:
 * a renamed variable, a changed type annotation, an added argument. Those are
 * refused as "not found" even when the change is obviously the one the model
 * meant.
 *
 * The OMP reference solves this with a scored line matcher
 * (`oh-my-pi/crates/pi-edit/src/fuzzy.rs`). This is a reimplementation of those
 * semantics, not a port of the Rust, and the scoring rules are kept because
 * they are the part that is load-bearing.
 *
 * ## The three tiers, in order
 *
 * 1. **Literal.** A byte-exact `indexOf` over the LF-normalized content. Fast,
 *    certain, and the common case. Byte offsets come from this tier.
 * 2. **Normalized.** The same search in normalized space. Certain about *text*,
 *    but the match may sit at a different offset than in the original, so the
 *    result carries the normalized content for the caller to reconcile.
 * 3. **Scored.** A line-window search scoring each window against the target
 *    lines. This is the only tier that can match a line whose content differs,
 *    so it is also the only tier that needs an ambiguity rule.
 *
 * ## Why scored matching is bounded and safe
 *
 * A scorer that could match *anything* would be a licence to corrupt a file. Two
 * rules prevent that:
 *
 * - **A hard threshold.** Below `DEFAULT_THRESHOLD` nothing matches, however
 *   close. OMP uses 0.95 (`fuzzy.rs:14`).
 * - **Ambiguity is a refusal, not a guess.** If more than one window clears the
 *   threshold, the match is only accepted when one is *dominant* — high enough
 *   absolutely and far enough ahead of the runner-up. OMP's constants
 *   (`fuzzy.rs:32,34`): 0.97 and a 0.08 margin. Otherwise the outcome is a
 *   refusal that reports every candidate line, so the model can add context.
 *
 * A model message is untrusted input, and a patch is untrusted input. This module
 * therefore never widens what it will accept on the model's say-so: it either
 * finds the text with evidence, or it refuses and says why.
 */

/** Highest confidence accepted by default. Mirrors OMP's `fuzzy.rs:14`. */
export const DEFAULT_THRESHOLD = 0.95;

/** A dominant match must be at least this confident, whatever the threshold. */
export const DOMINANT_MIN_CONFIDENCE = 0.97;

/** ...and this far ahead of the runner-up. Mirrors OMP's `fuzzy.rs:34`. */
export const DOMINANT_DELTA = 0.08;

/** How many candidate lines a refusal reports before truncating. */
export const MAX_RECORDED_MATCHES = 10;

/** Which tier produced a match. Reported so a caller can explain the result. */
export type MatchTier = "literal" | "normalized" | "scored";

/** One accepted or candidate match. */
export interface TextMatch {
	/** Text actually present in the file, which for a scored match is the window. */
	readonly actualText: string;
	/** Byte offset into the content the offsets were computed against. */
	readonly startIndex: number;
	/** 1-based line of the match in the content. */
	readonly startLine: number;
	/** 1.0 for a literal or normalized match; the score for a scored one. */
	readonly confidence: number;
	readonly tier: MatchTier;
}

/** Why a search did not produce a match, or produced more than one. */
export interface MatchFailure {
	/** Occurrences, when the failure is ambiguity. */
	readonly occurrences?: number;
	/** 1-based line numbers of the candidates, for a disambiguation message. */
	readonly occurrenceLines?: readonly number[];
	/** A short excerpt of each candidate, so the model can tell them apart. */
	readonly occurrencePreviews?: readonly string[];
	/** The best near-miss, when nothing matched. Its score is below the threshold. */
	readonly closest?: TextMatch;
	/** How many windows cleared the threshold without one being dominant. */
	readonly aboveThresholdCount?: number;
}

export interface FindMatchOptions {
	/** Admit scored matching. Default false: normalized-only is the safe default. */
	readonly allowScored?: boolean;
	/** Override the acceptance threshold. */
	readonly threshold?: number;
}

/** The outcome of one search: a match, a failure, or nothing at all. */
export type MatchOutcome =
	| { readonly matched: TextMatch; readonly failure?: undefined }
	| { readonly matched?: undefined; readonly failure: MatchFailure };

/**
 * Normalizes text for comparison.
 *
 * Deliberately lossy and deliberately small. Every transformation here makes two
 * different byte sequences compare equal, so each one is a place where a match
 * could succeed against text the model did not write. Trailing whitespace and
 * quote/dash/space equivalence are safe: they are invisible in review. Anything
 * that changes identifiers would not be.
 */
export function normalizeForMatch(text: string): string {
	return (
		text
			// Line endings first. Without this a CRLF file never matches an
			// LF-quoted target, because `\r` survives every other normalization and
			// the two forms are never compared. This was a real miss: a Windows
			// checkout defeated the whole normalized tier.
			.replace(/\r\n/g, "\n")
			// Trailing whitespace is never semantically meaningful in a source line.
			.replace(/[ \t]+$/gm, "")
			// Smart quotes and primes read as ASCII in every renderer.
			.replace(/[‘’‚‛]/g, "'")
			.replace(/[“”„‟]/g, '"')
			.replace(/[′]/g, "'")
			// Unicode dashes and minus, which appear in prose and in diffs.
			.replace(/[‐‑‒–—―−]/g, "-")
			// Non-breaking and other exotic spaces, which a formatter may introduce.
			.replace(/[   -   　]/g, " ")
			.normalize("NFC")
	);
}

function lineStartOffsets(content: string): number[] {
	const offsets: number[] = [0];
	for (let index = 0; index < content.length; index++) {
		if (content[index] === "\n") offsets.push(index + 1);
	}
	return offsets;
}

function lineNumberAt(offsets: readonly number[], index: number): number {
	let low = 0;
	let high = offsets.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (offsets[mid] <= index) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

/** A short excerpt of the lines around a candidate, for a refusal message. */
function previewWindow(content: string, lineIndex: number, radius = 2): string {
	const lines = content.split("\n");
	const start = Math.max(0, lineIndex - radius);
	const end = Math.min(lines.length, lineIndex + radius + 1);
	return lines
		.slice(start, end)
		.map((line, offset) => `${start + offset + 1}: ${line}`)
		.join("\n");
}

/** Every occurrence of `target` in `content`, as byte offsets. */
function allOccurrences(content: string, target: string): number[] {
	if (target.length === 0) return [];
	const found: number[] = [];
	let from = 0;
	for (;;) {
		const relative = content.indexOf(target, from);
		if (relative === -1) break;
		found.push(relative);
		// Advance past the end of this match so overlapping occurrences are not
		// double-counted; `replace` semantics need the same behaviour.
		from = relative + target.length;
	}
	return found;
}

/**
 * Similarity of two lines, in [0, 1].
 *
 * Normalized comparison first, then a cheap containment bonus, then a
 * character-level ratio. The ratio is the floor that keeps a line differing in
 * one identifier from scoring 0, which is what makes a one-token rename
 * matchable at all.
 */
export function lineSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const maxLength = Math.max(a.length, b.length);
	if (maxLength === 0) return 1;
	// Length difference is an upper bound on achievable similarity, used to
	// reject a hopeless candidate without running the expensive ratio.
	const lengthBound = 1 - Math.abs(a.length - b.length) / maxLength;
	if (lengthBound <= 0) return 0;
	if (a.includes(b) || b.includes(a)) return Math.max(0.9, lengthBound);
	return lengthBound * characterRatio(a, b);
}

/** Character-multiset overlap, in [0, 1]. */
function characterRatio(a: string, b: string): number {
	const counts = new Map<string, number>();
	for (const char of a) counts.set(char, (counts.get(char) ?? 0) + 1);
	let shared = 0;
	for (const char of b) {
		const available = counts.get(char) ?? 0;
		if (available > 0) {
			counts.set(char, available - 1);
			shared++;
		}
	}
	return shared / Math.max(a.length, b.length);
}

/** Relative indentation depth per line, so a reindented block still matches. */
function relativeIndentDepths(lines: readonly string[]): number[] {
	const indents = lines.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
	const nonEmpty = lines
		.map((line, index) => (line.trim().length > 0 ? indents[index] : undefined))
		.filter((value): value is number => value !== undefined);
	if (nonEmpty.length === 0) return indents.map(() => 0);
	const minIndent = Math.min(...nonEmpty);
	const unit =
		nonEmpty
			.map((indent) => indent - minIndent)
			.filter((step) => step > 0)
			.sort((a, b) => a - b)[0] ?? 1;
	return indents.map((indent, index) =>
		lines[index].trim().length === 0 || unit === 0 ? 0 : Math.round((indent - minIndent) / unit),
	);
}

/** Normalized line, optionally prefixed by relative indent depth. */
function normalizeLine(line: string, depth: number | undefined): string {
	const trimmed = normalizeForMatch(line.trim());
	if (trimmed.length === 0) return depth === undefined ? "" : `${depth}|`;
	return depth === undefined ? trimmed : `${depth}|${trimmed}`;
}

/**
 * Scores the window of `contentLines` starting at `index` against `pattern`.
 *
 * `minScore` is an early-exit bound: a window that cannot reach the threshold
 * even if every remaining line matched perfectly is abandoned immediately, which
 * is what keeps this linear in practice rather than quadratic.
 */
function scoreWindow(
	contentLines: readonly string[],
	pattern: readonly string[],
	index: number,
	minScore: number,
): number {
	if (index + pattern.length > contentLines.length) return 0;
	const count = pattern.length;
	if (count === 0) return 0;
	let total = 0;
	for (let offset = 0; offset < count; offset++) {
		const line = contentLines[index + offset];
		const expected = pattern[offset];
		if (line === expected) {
			total += 1;
			continue;
		}
		const remaining = count - offset - 1;
		const maxLength = Math.max(line.length, expected.length);
		const upperBound = maxLength === 0 ? 1 : 1 - Math.abs(line.length - expected.length) / maxLength;
		// Bail out when even a perfect remainder cannot reach the threshold.
		if ((total + upperBound + remaining) / count < minScore) return total / count;
		if (upperBound > 0) total += lineSimilarity(line, expected);
		if ((total + remaining) / count < minScore) return total / count;
	}
	return total / count;
}

interface ScoredSearch {
	best?: { index: number; score: number };
	secondBest: number;
	aboveThreshold: number;
	/** 0-based line indexes of every window that cleared the threshold. */
	candidateLines: number[];
}

/** Scores every window, keeping the best two for the dominance test. */
function searchScored(contentLines: readonly string[], pattern: readonly string[], threshold: number): ScoredSearch {
	const state: ScoredSearch = { secondBest: 0, aboveThreshold: 0, candidateLines: [] };
	for (let index = 0; index + pattern.length <= contentLines.length; index++) {
		const score = scoreWindow(contentLines, pattern, index, threshold);
		if (score < threshold) continue;
		state.aboveThreshold++;
		// Bounded: only enough to build an actionable refusal. A file with a
		// thousand equally-plausible windows would otherwise produce a thousand-line
		// message the model cannot use.
		if (state.candidateLines.length < MAX_RECORDED_MATCHES) state.candidateLines.push(index);
		if (state.best === undefined || score > state.best.score) {
			state.secondBest = state.best?.score ?? 0;
			state.best = { index, score };
		} else if (score > state.secondBest) {
			state.secondBest = score;
		}
	}
	return state;
}

/**
 * Locates `target` in `content`.
 *
 * Never throws and never guesses. A caller that gets `failure` has to decide
 * what to do, and the common correct action is to tell the model to add context.
 */
export function findMatch(content: string, target: string, options: FindMatchOptions = {}): MatchOutcome {
	if (target.length === 0) return { failure: {} };
	const offsets = lineStartOffsets(content);

	// Tier 1: literal.
	const exact = allOccurrences(content, target);
	if (exact.length === 1) {
		return {
			matched: {
				actualText: target,
				startIndex: exact[0],
				startLine: lineNumberAt(offsets, exact[0]),
				confidence: 1,
				tier: "literal",
			},
		};
	}
	if (exact.length > 1) return { failure: describeOccurrences(content, offsets, exact) };

	// Tier 2: normalized. Offsets are in normalized space, which the caller
	// reconciles against the original; `actualText` is the normalized target.
	const normalizedContent = normalizeForMatch(content);
	const normalizedTarget = normalizeForMatch(target);
	const normalized = allOccurrences(normalizedContent, normalizedTarget);
	if (normalized.length === 1) {
		return {
			matched: {
				actualText: normalizedTarget,
				startIndex: normalized[0],
				startLine: lineNumberAt(lineStartOffsets(normalizedContent), normalized[0]),
				confidence: 1,
				tier: "normalized",
			},
		};
	}
	if (normalized.length > 1) {
		return { failure: describeOccurrences(normalizedContent, lineStartOffsets(normalizedContent), normalized) };
	}

	// Tier 3: scored, and only when the caller opted in.
	if (!options.allowScored) return { failure: {} };
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");

	// Two passes. The first ignores indentation, so a reindented block is
	// reachable; the second requires it to match, which recovers a block that was
	// merely moved. OMP runs the same two-tier search (`fuzzy.rs`).
	const contentDepths = relativeIndentDepths(contentLines);
	const targetDepths = relativeIndentDepths(targetLines);
	const contentWithDepth = contentLines.map((line, index) => normalizeLine(line, contentDepths[index]));
	const targetWithDepth = targetLines.map((line, index) => normalizeLine(line, targetDepths[index]));

	const loose = searchScored(
		contentLines.map((line) => normalizeLine(line, undefined)),
		targetLines.map((line) => normalizeLine(line, undefined)),
		threshold,
	);
	const strict = loose.best ? searchScored(contentWithDepth, targetWithDepth, threshold) : loose;
	const chosen = strict.aboveThreshold >= loose.aboveThreshold ? strict : loose;

	// When nothing cleared the threshold, search again with no floor so the failure
	// can name the closest text and its line. A silent empty failure tells the
	// model nothing it can act on, and it then retries the same wrong text.
	const relaxed =
		chosen.best === undefined
			? searchScored(
					contentLines.map((line) => normalizeLine(line, undefined)),
					targetLines.map((line) => normalizeLine(line, undefined)),
					0,
				)
			: chosen;
	const best = relaxed.best;
	const startIndex = offsets[best?.index ?? 0] ?? 0;
	const closest: TextMatch | undefined = best
		? {
				actualText: contentLines.slice(best.index, best.index + targetLines.length).join("\n"),
				startIndex,
				startLine: best.index + 1,
				confidence: best.score,
				tier: "scored",
			}
		: undefined;

	if (!closest) return { failure: {} };

	if (chosen.aboveThreshold === 1) return { matched: closest };
	// Several windows cleared the bar. Accept only a dominant one: high enough
	// in absolute terms and clearly ahead of the runner-up. Anything else is a
	// refusal that names the candidates, because a coin-flip between two
	// plausible windows is exactly the case that corrupts a file silently.
	if (closest.confidence >= DOMINANT_MIN_CONFIDENCE && closest.confidence - chosen.secondBest >= DOMINANT_DELTA) {
		return { matched: closest };
	}
	return {
		failure: {
			occurrences: chosen.aboveThreshold,
			// Real line numbers, 1-based, not sequential placeholders: the model uses
			// these to decide which region to quote, so a synthetic list is worse
			// than none.
			occurrenceLines: chosen.candidateLines.map((index) => index + 1),
			occurrencePreviews: chosen.candidateLines.map((index) => previewWindow(content, index)),
			closest,
			aboveThresholdCount: chosen.aboveThreshold,
		},
	};
}

function describeOccurrences(
	content: string,
	offsets: readonly number[],
	occurrences: readonly number[],
): MatchFailure {
	const recorded = occurrences.slice(0, MAX_RECORDED_MATCHES);
	return {
		occurrences: occurrences.length,
		occurrenceLines: recorded.map((index) => lineNumberAt(offsets, index)),
		occurrencePreviews: recorded.map((index) =>
			previewWindow(content, Math.max(0, content.slice(0, index).split("\n").length - 1)),
		),
	};
}

/**
 * Renders a refusal the model can act on.
 *
 * The instruction matters more than the diagnostics: the model needs to know
 * that adding context lines is the fix, or it will retry the same text and fail
 * the same way.
 */
export function formatMatchFailure(path: string, _target: string, failure: MatchFailure): string {
	if (failure.occurrences !== undefined && failure.occurrences > 1) {
		const shown = failure.occurrenceLines?.length ?? 0;
		const more = failure.occurrences > shown ? ` (showing the first ${shown} of ${failure.occurrences})` : "";
		const previews = failure.occurrencePreviews?.join("\n\n") ?? "";
		return `Found ${failure.occurrences} occurrences of the text in ${path}${more}:\n\n${previews}\n\nAdd more surrounding context so the match is unique.`;
	}
	const closest = failure.closest;
	if (closest) {
		return (
			`No exact match for the text in ${path}. The closest text scores ${(closest.confidence * 100).toFixed(1)}%, ` +
			`which is below the ${(DEFAULT_THRESHOLD * 100).toFixed(0)}% required to edit safely. ` +
			`Closest at line ${closest.startLine}:\n\n${closest.actualText}\n\n` +
			"Re-read the file and use the exact current text, or include more context."
		);
	}
	return `Could not find the text in ${path}. Re-read the file and use its exact current content.`;
}
