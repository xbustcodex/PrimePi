/**
 * Shared helpers for tool-rendered UI components.
 */
import type { Theme, ThemeBg } from "../theme/index.ts";
import { padding, truncateToWidth, visibleWidth } from "../utils.ts";
import type { State } from "./types.ts";

/** Cached typed-array scratch space for hashing non-string primitives. */
const hashBuf = new ArrayBuffer(8);
const hashView = new DataView(hashBuf);
const hashBytes1 = new Uint8Array(hashBuf, 0, 1);
const hashBytes4 = new Uint8Array(hashBuf, 0, 4);
const hashBytes8 = new Uint8Array(hashBuf, 0, 8);

/**
 * Incremental key builder for memoisation keys.
 *
 * The reference chains `Bun.hash.xxHash64` calls by seeding. Prime Pi has no Bun, and xxHash64
 * has no node equivalent, so this is FNV-1a over a 64-bit accumulator.
 *
 * That substitution is safe here *because of what this is for*: these values become cache keys,
 * so they need to be stable within a process and cheap to mix, not identical to the reference's.
 * Anything that persisted the value would need the real algorithm.
 */
export class Hasher {
	#h = 0n;

	/** Feed a string. */
	str(s: string): this {
		hashView.setUint32(0, s.length);
		this.#h = fnv1a64(hashBytes4, this.#h);
		this.#h = fnv1a64(s, this.#h);
		return this;
	}

	/** Feed an unsigned 32-bit integer. */
	u32(n: number): this {
		hashView.setUint32(0, n);
		this.#h = fnv1a64(hashBytes4, this.#h);
		return this;
	}

	/** Feed a 64-bit bigint. */
	u64(n: bigint): this {
		hashView.setBigUint64(0, n);
		this.#h = fnv1a64(hashBytes8, this.#h);
		return this;
	}

	/** Feed a boolean (single byte: 1 = true, 0 = false). */
	bool(b: boolean): this {
		hashView.setUint8(0, b ? 1 : 0);
		this.#h = fnv1a64(hashBytes1, this.#h);
		return this;
	}

	/** Feed a value that may be `undefined` or `null` (hashed as a 0xFF sentinel byte). */
	optional(v: string | undefined | null): this {
		if (v == null) {
			hashView.setUint8(0, 0xff);
			this.#h = fnv1a64(hashBytes1, this.#h);
		} else {
			this.#h = fnv1a64(v, this.#h);
		}
		return this;
	}

	/** Return the final hash digest. */
	digest(): bigint {
		return this.#h;
	}
}

/** Render-cache entry used by tool renderers. */
export interface RenderCache {
	key: bigint;
	lines: string[];
}

/** Build indentation and continuing branches for ancestor levels. */
export function buildTreePrefix(ancestors: boolean[], theme: Theme): string {
	return ancestors.map((hasNext) => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

/** Return the branch glyph for a final or continuing tree item. */
export function getTreeBranch(isLast: boolean, theme: Theme): string {
	return isLast ? theme.tree.last : theme.tree.branch;
}

/** Return the continuation prefix for subsequent lines of a tree item. */
export function getTreeContinuePrefix(isLast: boolean, theme: Theme): string {
	return isLast ? "   " : `${theme.tree.vertical}  `;
}

/** Pad or truncate visible text to exactly `width` columns and optionally apply a background. */
export function padToWidth(text: string, width: number, bgFn?: (s: string) => string): string {
	if (width <= 0) return bgFn ? bgFn(text) : text;
	const w = visibleWidth(text);
	if (w === width) return bgFn ? bgFn(text) : text;
	const fitted = w < width ? text + padding(width - w) : truncateToWidth(text, width);
	const drift = width - visibleWidth(fitted);
	const padded = drift > 0 ? fitted + padding(drift) : fitted;
	return bgFn ? bgFn(padded) : padded;
}

/** Resolve a tool output state to its background color token. */
export function getStateBgColor(state: State): ThemeBg {
	if (state === "success") return "toolSuccessBg";
	if (state === "error") return "toolErrorBg";
	return "toolPendingBg";
}

/**
 * Fold one value into a 64-bit FNV-1a accumulator.
 *
 * Strings and byte views are mixed byte-wise; numbers and booleans are folded through their
 * 64-bit representation. `undefined`/`null` mix a sentinel so that a missing value and an empty
 * one do not collide.
 */
function fnv1a64(value: unknown, seed: bigint): bigint {
	const PRIME = 0x100000001b3n;
	const OFFSET = 0xcbf29ce484222325n;
	let h = seed === 0n ? OFFSET : seed;
	const mix = (byte: number): void => {
		h ^= BigInt(byte & 0xff);
		h = (h * PRIME) & 0xffffffffffffffffn;
	};
	if (typeof value === "string") {
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			mix(code & 0xff);
			mix(code >>> 8);
		}
		return h;
	}
	if (value === undefined) {
		mix(0xfe);
		return h;
	}
	if (value === null) {
		mix(0xff);
		return h;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		const asBig = BigInt(value === true ? 1 : value === false ? 0 : (value as number | bigint));
		for (let i = 0; i < 8; i++) mix(Number((asBig >> BigInt(i * 8)) & 0xffn));
		return h;
	}
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
		for (const byte of bytes) mix(byte);
		return h;
	}
	mix(0xfd);
	return h;
}
