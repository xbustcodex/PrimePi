/**
 * Stream loop detection: catching a model that never finishes.
 *
 * ## The failure this exists for
 *
 * Some models fall into a degenerate reasoning loop — re-emitting the same
 * paragraph intent with cosmetic wording drift, burning the entire output budget
 * without ever calling a tool or answering. The runaway is **not**
 * byte-identical, so a verbatim repeat check alone misses it.
 *
 * ## Why the exact detector works on the reversed string
 *
 * A repeated suffix is a repeated *prefix* once reversed, and the longest such
 * run is a Z-function. So the text is reversed, the Z-array is computed in O(n),
 * and `z[len]` gives the length of the repetition starting at `len` from the
 * end. The naive alternative — testing every candidate period against the tail —
 * is O(n·maxUnit), which at a 4096-character window is roughly four million
 * comparisons *per scan*, on every token-sized delta. At streaming cadence that
 * is the difference between a guard and a stall.
 *
 * ## Three thresholds, because a cycle's size changes its evidence
 *
 * A short unit repeating four times is a loop; a long unit repeating twice may
 * be a table or a repeated block that happens to be long. So a unit up to
 * `EXACT_SHORT_MAX_UNIT` needs four repetitions and at least
 * `EXACT_SHORT_MIN_REPEATED_CHARS` characters, while a longer unit needs three
 * and more total characters. Both a repetition count and a character floor must
 * clear, which is what stops a 2-character unit tripping on `"!!!!"` padding.
 *
 * The unit must also contain a letter or an emoji — a cycle of pure punctuation
 * is formatting, not reasoning.
 *
 * ## Scanning is on a cadence, not per delta
 *
 * Deltas arrive token-sized. Re-running the detector on every one is quadratic
 * in the *number* of deltas for no benefit, since a cycle spanning a stride
 * boundary is still visible in the next scan. The tail is capped at
 * `EXACT_TAIL_WINDOW` so a long stream cannot grow the scan cost without bound.
 */

/** Rolling character window kept for exact cycle detection. */
export const EXACT_TAIL_WINDOW = 4096;

/** Longest period considered. Beyond this it is not a recognisable unit. */
export const EXACT_MAX_UNIT = 1024;

/** Characters between scans. */
export const EXACT_CHECK_STRIDE = 128;

/** Units at or below this length need more repetitions to count. */
export const EXACT_SHORT_MAX_UNIT = 60;

/** Character floor for a short unit. */
export const EXACT_SHORT_MIN_REPEATED_CHARS = 180;

/** Character floor for a long unit. */
export const EXACT_LONG_MIN_REPEATED_CHARS = 1024;

/**
 * Finds an exact repeated suffix.
 *
 * Returns the repeated unit and how many times it occurs back-to-back, or null.
 * The Z-array is computed over the reversed text, where a repeated suffix
 * becomes a repeated prefix and `z[len]` is the run length starting `len`
 * characters from the end.
 */
export function detectExactSuffixCycle(text: string): { unit: string; count: number } | null {
	// Below the floor even a maximally repetitive string is not evidence.
	if (text.length < EXACT_SHORT_MIN_REPEATED_CHARS) return null;
	const reversed = text.split("").reverse().join("");
	const z = new Uint16Array(reversed.length);
	let left = 0;
	let right = 0;
	for (let i = 1; i < reversed.length; i++) {
		// Inside the current rightmost match, start from the mirrored position; the
		// Z-function's reuse rule is what keeps this linear.
		if (i <= right) z[i] = Math.min(right - i + 1, z[i - left]);
		while (i + z[i]! < reversed.length && reversed[z[i]!] === reversed[i + z[i]!]) z[i]!++;
		if (i + z[i]! - 1 > right) {
			left = i;
			right = i + z[i]! - 1;
		}
	}

	// Three repetitions are required, so a period longer than a third of the
	// window cannot be one — checking it would be arithmetic on a value that
	// cannot produce a count of 3.
	const maxUnit = Math.min(EXACT_MAX_UNIT, Math.floor(reversed.length / 3));
	for (let len = 2; len <= maxUnit; len++) {
		const count = 1 + Math.floor(z[len]! / len);
		const short = len <= EXACT_SHORT_MAX_UNIT;
		// Both a repetition count and a character floor must clear. The count alone
		// would let a 2-character unit trip on repeated punctuation; the floor alone
		// would let a long block that is legitimately repeated count.
		if (count < (short ? 4 : 3)) continue;
		if (len * count < (short ? EXACT_SHORT_MIN_REPEATED_CHARS : EXACT_LONG_MIN_REPEATED_CHARS)) continue;
		const unit = text.slice(-len);
		// A cycle must contain something that reads as reasoning, not just a letter.
		// Requiring two letters is what separates a repeated paragraph from a repeated
		// single character: a model padding its output with "x" trips every count and
		// length threshold while carrying no information, and terminating that stream
		// throws away a turn that may still be about to answer. A single character is
		// still a legitimate *part* of a cycle, found at a longer `len` when the
		// enclosing period is the real one.
		if (!isReasoningUnit(unit)) continue;
		return { unit, count };
	}
	return null;
}

/**
 * Whether a repeated unit looks like reasoning rather than padding.
 *
 * The whole unit must read as text: an emoji, or at least two letters that are
 * not simply one character repeated to reach the length. Testing the unit as a
 * substring is not enough — `"xx"` contains two letters, so a stream of a single
 * repeated character would still pass once the period reached two.
 */
export function isReasoningUnit(unit: string): boolean {
	if (/\p{Extended_Pictographic}/u.test(unit)) return true;
	// Collapsing each run of one repeated letter to a single character first means a
	// plain two-letter match can only fire on genuinely different letters.
	return /\p{L}{2}/u.test(unit.replace(/(\p{L})\1+/gu, "$1"));
}

/**
 * Watches a stream and reports the first loop it sees.
 *
 * Deltas are pushed as they arrive; `flush` runs one final check when the block
 * ends, because a stream can stop before the next cadence boundary and the
 * trailing cycle would otherwise go unexamined.
 */
export class ThinkingLoopDetector {
	#tail = "";
	#scannedAt = 0;

	push(delta: string): string | null {
		if (!delta) return null;
		this.#tail += delta;
		// Capped so a long stream cannot grow the scan cost without bound.
		if (this.#tail.length > EXACT_TAIL_WINDOW) this.#tail = this.#tail.slice(-EXACT_TAIL_WINDOW);
		this.#scannedAt += delta.length;
		// A cadence rather than a per-delta scan: a cycle spanning a stride boundary
		// is still visible at the next scan, and per-delta would be quadratic in the
		// number of deltas for no gain.
		if (this.#scannedAt < EXACT_CHECK_STRIDE && delta.length < EXACT_CHECK_STRIDE) return null;
		this.#scannedAt = 0;
		return this.#check();
	}

	/** The final check, run when the block ends. */
	flush(): string | null {
		return this.#check();
	}

	#check(): string | null {
		const cycle = detectExactSuffixCycle(this.#tail);
		if (!cycle) return null;
		return `repeated an exact ${cycle.unit.length}-character cycle ${cycle.count}× back-to-back`;
	}
}

/** The marker a synthesised error carries so a caller can tell it apart. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";
