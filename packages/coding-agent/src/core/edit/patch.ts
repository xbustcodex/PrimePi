/**
 * Unified-diff parsing and application.
 *
 * ## Why this is a separate layer from `edit`
 *
 * `edit` replaces exact text the model quotes. A patch expresses the same intent
 * as a diff, which is what a model produces when it has read a file and wants to
 * show the change rather than quote it. The two are complementary: quoting is
 * safer for a surgical change, a patch is cheaper for a long one, and a model
 * that has both can choose.
 *
 * ## The security property this layer owns
 *
 * **A patch is untrusted model output.** A `+++ b/../../.ssh/authorized_keys`
 * header is not a path the tool may write; it is a string in a message. Every
 * target goes through {@link resolvePatchTarget}, which requires the result to
 * stay inside the workspace root *physically* — after symlink resolution, so a
 * symlink planted inside the workspace cannot be used to write outside it. That
 * check lives here rather than in the tool so there is exactly one place a
 * patch-derived path becomes a real path.
 *
 * OMP has the same concern in `crates/pi-edit/src/path_policy.rs` and compares
 * `physical_path` on both sides for exactly this reason
 * (`path_policy.rs:252-260`). Its `apply_patch` mode, however, does not itself
 * validate a `+++` header; it relies on the caller. Validating here means a
 * caller cannot forget.
 *
 * ## Locating a hunk
 *
 * The line number in a `@@` header is a *hint*, not the truth. Content moves;
 * line numbers do not move with it. So each hunk is located by searching for its
 * context, preferring the recorded line and searching outward from it. A hunk
 * whose context cannot be found is a refusal, never a best-effort insertion —
 * a patch applied at the wrong offset is worse than no patch.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** One parsed hunk, in original-file coordinates. */
export interface ParsedHunk {
	/** 1-based start line in the original file, as the header claimed. */
	readonly oldStart: number;
	/** Count of context and removed lines in the original. */
	readonly oldCount: number;
	/** Count of context and added lines in the result. */
	readonly newCount: number;
	/** Context and removed lines, in order. Lines prefixed `-` are removals. */
	readonly lines: readonly string[];
	/** The `@@` header, for error messages. */
	readonly header: string;
}

/** A parsed patch: a target path plus ordered hunks. */
export interface ParsedPatch {
	/** The `+++ b/<path>` target, as written in the patch. Untrusted. */
	readonly target: string;
	/** The `--- a/<path>` original, for the create/delete distinction. */
	readonly original: string;
	readonly hunks: readonly ParsedHunk[];
}

/** Why a patch could not be parsed. */
export type PatchParseError =
	| { readonly kind: "no-target" }
	| { readonly kind: "malformed-header"; readonly line: string }
	| { readonly kind: "malformed-hunk"; readonly header: string }
	| { readonly kind: "no-hunks" }
	| { readonly kind: "too-large"; readonly bytes: number; readonly limit: number };

export type PatchParseResult =
	| { readonly ok: true; readonly patch: ParsedPatch }
	| { readonly ok: false; readonly error: PatchParseError };

/**
 * Cap on patch size.
 *
 * A patch arrives in a model message, so its size is bounded by the context
 * window — but a tool argument is not, and a hostile or malfunctioning caller
 * should not be able to make this allocate without limit.
 */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/** Cap on hunks, as a second bound on the per-hunk search below. */
export const MAX_HUNKS = 5_000;

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified diff.
 *
 * Only the `---`/`+++`/`@@` grammar is accepted, and a hunk header must carry
 * its line numbers. A simplified "context-only" patch with no numbers is
 * refused: without them there is no hint, and an unlocatable patch is exactly
 * the case this layer exists to refuse.
 */
export function parsePatch(input: string): PatchParseResult {
	if (input.length > MAX_PATCH_BYTES) {
		return { ok: false, error: { kind: "too-large", bytes: input.length, limit: MAX_PATCH_BYTES } };
	}
	const lines = input.split("\n");
	let original: string | undefined;
	let target: string | undefined;
	const hunks: ParsedHunk[] = [];
	let current: { header: string; oldStart: number; oldCount: number; newCount: number; lines: string[] } | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith("--- ")) {
			original = stripPrefix(line.slice(4));
			continue;
		}
		if (line.startsWith("+++ ")) {
			target = stripPrefix(line.slice(4));
			continue;
		}
		const header = HEADER.exec(line);
		if (header) {
			if (current) hunks.push(finishHunk(current));
			if (hunks.length >= MAX_HUNKS) {
				return { ok: false, error: { kind: "too-large", bytes: hunks.length, limit: MAX_HUNKS } };
			}
			current = {
				header: line,
				oldStart: Number(header[1]),
				// An omitted count means 1, per unified-diff convention.
				oldCount: header[2] === undefined ? 1 : Number(header[2]),
				newCount: header[4] === undefined ? 1 : Number(header[4]),
				lines: [],
			};
			continue;
		}
		// `\ No newline at end of file` is advisory; it changes no bytes we apply.
		if (line.startsWith("\\ No newline")) continue;
		if (!current) continue;
		if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
			current.lines.push(line);
			continue;
		}
		// A bare empty line inside a hunk is an empty context line, which some
		// tools emit rather than a line containing a single space.
		if (line.length === 0) {
			current.lines.push(" ");
			continue;
		}
		if (current) {
			hunks.push(finishHunk(current));
			current = undefined;
		}
	}
	if (current) hunks.push(finishHunk(current));

	if (target === undefined) return { ok: false, error: { kind: "no-target" } };
	if (hunks.length === 0) return { ok: false, error: { kind: "no-hunks" } };
	return { ok: true, patch: { target, original: original ?? target, hunks } };
}

function finishHunk(current: {
	header: string;
	oldStart: number;
	oldCount: number;
	newCount: number;
	lines: string[];
}): ParsedHunk {
	return {
		oldStart: current.oldStart,
		oldCount: current.oldCount,
		newCount: current.newCount,
		lines: current.lines,
		header: current.header,
	};
}

function stripPrefix(value: string): string {
	// Strip a trailing tab-separated timestamp, which `git diff` emits.
	const trimmed = value.replace(/\t.*$/, "").trim();
	if (trimmed === "/dev/null") return trimmed;
	return trimmed.replace(/^[ab]\//, "");
}

/** A hunk that could not be placed in the file. */
export type HunkApplyError =
	| { readonly kind: "not-found"; readonly header: string }
	| { readonly kind: "ambiguous"; readonly header: string; readonly lines: readonly number[] }
	| { readonly kind: "overlap"; readonly header: string }
	| { readonly kind: "count-mismatch"; readonly header: string; readonly expected: number; readonly actual: number };

export type HunkApplyResult =
	| { readonly ok: true; readonly content: string; readonly applied: number }
	| { readonly ok: false; readonly error: HunkApplyError };

/** How many lines around a hint to search before giving up. */
const HUNK_SEARCH_RADIUS = 200;

/**
 * Applies a parsed patch to `content`.
 *
 * All-or-nothing. Hunks are located and validated first, and only a patch whose
 * every hunk places cleanly is written; a partial apply is reported as a
 * failure with nothing changed. A caller that retries a partially applied patch
 * against an already-modified file is the worst outcome here, and returning one
 * is how it happens.
 */
export function applyPatch(content: string, patch: ParsedPatch): HunkApplyResult {
	// Line endings are detected before normalization and restored on the way out.
	// Without this a patch to a CRLF file silently rewrites the whole file to LF,
	// showing up as a diff touching every line — the most confusing possible
	// outcome for a change meant to touch one.
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingNewline = content.endsWith("\n");
	const originalLines = content.replace(/\r\n/g, "\n").split("\n");
	if (hadTrailingNewline) originalLines.pop();

	// Locate every hunk before mutating anything.
	const placed: { hunk: ParsedHunk; at: number; consumed: number }[] = [];
	const taken: boolean[] = new Array(originalLines.length).fill(false);

	for (const hunk of patch.hunks) {
		const search = locateHunk(originalLines, hunk);
		if ("kind" in search) return { ok: false, error: search };
		// Overlap check against already-placed hunks, in original coordinates.
		for (let offset = 0; offset < search.consumed; offset++) {
			if (taken[search.at + offset]) {
				return { ok: false, error: { kind: "overlap", header: hunk.header } };
			}
		}
		for (let offset = 0; offset < search.consumed; offset++) taken[search.at + offset] = true;
		placed.push({ hunk, at: search.at, consumed: search.consumed });
	}

	// Apply in reverse so earlier offsets stay valid.
	placed.sort((a, b) => b.at - a.at);
	const result = [...originalLines];
	for (const { hunk, at, consumed } of placed) {
		const replacement = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
		result.splice(at, consumed, ...replacement);
	}

	const body = result.join("\n") + (hadTrailingNewline ? "\n" : "");
	return {
		ok: true,
		// Restore the file's own line ending, so a one-line patch to a CRLF file
		// does not rewrite every line.
		content: lineEnding === "\r\n" ? body.replace(/\n/g, "\r\n") : body,
		applied: placed.length,
	};
}

type HunkLocation = { at: number; consumed: number; candidates?: readonly number[] };

function locateHunk(lines: readonly string[], hunk: ParsedHunk): HunkLocation | HunkApplyError {
	// Context and removed lines are what must be present, in order. Added lines
	// are absent from the original and are not part of the search.
	const expected: string[] = [];
	for (const line of hunk.lines) {
		if (line.startsWith("+")) continue;
		expected.push(line.slice(1));
	}
	if (expected.length === 0) {
		// A pure insertion has no context to search for. Its only anchor is the
		// recorded line, which is a hint we cannot verify — so it is placed at the
		// hint and only when the count says the file is otherwise unchanged.
		const at = Math.min(Math.max(0, hunk.oldStart - 1), lines.length);
		return { at, consumed: 0 };
	}

	const matches: number[] = [];
	// Search the whole file: content is the truth and the line number is a hint.
	for (let index = 0; index + expected.length <= lines.length; index++) {
		let hit = true;
		for (let offset = 0; offset < expected.length; offset++) {
			if (lines[index + offset] !== expected[offset]) {
				hit = false;
				break;
			}
		}
		if (hit) matches.push(index);
	}

	if (matches.length === 0) {
		// Nothing matched exactly. Try ignoring trailing whitespace, which is the
		// one difference a formatter or an editor will introduce without changing
		// meaning. Bounded and one-directional: it never widens what is accepted
		// beyond whitespace.
		const trimmedExpected = expected.map((line) => line.replace(/[ \t]+$/, ""));
		for (let index = 0; index + trimmedExpected.length <= lines.length; index++) {
			let hit = true;
			for (let offset = 0; offset < trimmedExpected.length; offset++) {
				if (lines[index + offset].replace(/[ \t]+$/, "") !== trimmedExpected[offset]) {
					hit = false;
					break;
				}
			}
			if (hit) matches.push(index);
		}
	}

	if (matches.length === 0) return { kind: "not-found", header: hunk.header };
	// One match, or several where the recorded line disambiguates them. The hint
	// is only trusted when exactly one candidate is within reach of it; a genuine
	// tie is a refusal.
	if (matches.length === 1) return { at: matches[0], consumed: expected.length };
	const nearHint = matches.filter((index) => Math.abs(index - (hunk.oldStart - 1)) <= HUNK_SEARCH_RADIUS);
	if (nearHint.length === 1) return { at: nearHint[0], consumed: expected.length };
	return { kind: "ambiguous", header: hunk.header, lines: nearHint.map((index) => index + 1) };
}

/**
 * Resolves a patch's declared target to a real path inside the workspace.
 *
 * The path in a patch is a string in a model message, so it is treated as
 * hostile input. Three properties, in order:
 *
 * 1. `/dev/null` means create, and is not resolved.
 * 2. An absolute path is rebased onto the root — a patch may not name a path
 *    outside the workspace by writing `/etc/passwd`.
 * 3. The result must be *physically* within the root, compared after resolving
 *    symlinks on both sides. Comparing the lexical path would let a symlink
 *    inside the workspace point anywhere.
 *
 * Returns the resolved absolute path, or a reason.
 */
export function resolvePatchTarget(
	target: string,
	options: { root: string; allowCreate?: boolean },
): { ok: true; path: string; isCreate: boolean } | { ok: false; reason: string } {
	if (target === "/dev/null") {
		return { ok: false, reason: "Patch target is /dev/null, which names no file to write." };
	}
	if (target.length === 0) {
		return { ok: false, reason: "Patch declares no target path." };
	}
	// A Windows drive-qualified path, a UNC path, or a URL scheme is not a
	// workspace-relative file and is refused rather than coerced.
	if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) {
		return { ok: false, reason: `Patch target ${JSON.stringify(target)} is not a workspace-relative path.` };
	}

	const root = physicalOrLexical(options.root);
	// An absolute path in a patch is rebased under the root, never honoured.
	// `resolve(target, root)` would discard the root when `target` is absolute, so
	// the leading separators are stripped and the result is built from the root
	// explicitly: a patch naming `/etc/passwd` writes `<root>/etc/passwd` or
	// nothing at all.
	const rebased = isAbsolute(target) ? resolve(root, target.replace(/^[/\\]+/, "")) : resolve(root, target);
	const physical = physicalOrLexical(rebased);
	if (!isWithinPhysical(root, physical)) {
		return { ok: false, reason: `Patch target ${JSON.stringify(target)} resolves outside the workspace.` };
	}
	return { ok: true, path: physical, isCreate: !existsSync(physical) };
}

/** Resolves symlinks where possible, falling back to the lexical path. */
function physicalOrLexical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	}
}

function isWithinPhysical(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export { isWithinPhysical as isWithin };
