/**
 * Document positions and `file://` URIs.
 *
 * ## Why this is its own module
 *
 * LSP positions are **UTF-16 code units**, zero-based, and every position this
 * project exchanges with a language server passes through here. Getting it
 * wrong does not fail loudly: a server asked about the wrong column answers
 * confidently about the wrong character, and the model reports a definition
 * that is subtly not the one it asked for.
 *
 * ## The astral case
 *
 * JavaScript strings are UTF-16, so `text.length` and a JavaScript string index
 * are both already in code units — which is why the naive implementation is
 * right for the first conversion and wrong for the second. The failure is in
 * **offsets**: a line containing an emoji occupies two code units and two UTF-16
 * units, and a byte offset or a code-point offset derived from it lands
 * mid-surrogate. Slicing there yields a lone surrogate, which is not a character
 * and renders as a replacement glyph.
 *
 * So the conversions are explicit, and the astral case is tested rather than
 * assumed. OMP does not do this: it reads `range.start.character` only to add 1
 * for 1-based display (`oh-my-pi/packages/coding-agent/src/lsp/utils.ts:190`)
 * and never converts to an offset, so the distinction is invisible there.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Position } from "./client.ts";

/**
 * Converts an LSP position to a string offset.
 *
 * Out-of-range input is clamped to the document rather than refused, and the
 * asymmetry is deliberate. A `character` past the end of a real line has one
 * honest answer — the end of that line — and refusing would make a trailing
 * cursor position fail, which is a normal thing for an editor to send. A `line`
 * past the end means the server believes the document is longer than it is, and
 * clamping to the final line is the closest defensible reading; the alternative
 * is answering a question about a document we do not have.
 *
 * What is *not* clamped is a position that splits a surrogate pair. That is not
 * an out-of-range position, it is an impossible one, and it is moved to the
 * character's end so the result is always whole text.
 */
export function positionToOffset(text: string, position: Position): number | undefined {
	const lineStart = lineStartOffsets(text);
	const lineIndex = Math.min(Math.max(0, position.line), Math.max(0, lineStart.length - 1));
	const start = lineStart[lineIndex];
	if (start === undefined) return undefined;

	const lineEnd = lineIndex + 1 < lineStart.length ? lineStart[lineIndex + 1] - 1 : text.length;
	const lineText = text.slice(start, lineEnd);

	// The position's character is a UTF-16 code-unit index into this line, which
	// is exactly what a JavaScript index is. The only care needed is not to split
	// a surrogate pair, which would produce a lone surrogate in the result.
	const requested = Math.max(0, position.character);
	const clamped = Math.min(requested, lineText.length);
	// If the requested index lands between the two halves of a surrogate pair,
	// move to the end of that pair: a position inside a character is not a
	// position, and returning the character's end is the closest honest answer.
	const safe = isInsideSurrogatePair(lineText, clamped) ? clamped + 1 : clamped;
	return start + Math.min(safe, lineText.length);
}

function isInsideSurrogatePair(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return false;
	const before = text.charCodeAt(index - 1);
	const after = text.charCodeAt(index);
	// A high surrogate immediately before and a low surrogate immediately after
	// means `index` falls between the halves of one astral character.
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Byte offsets of the start of each line. */
export function lineStartOffsets(text: string): number[] {
	const offsets = [0];
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") offsets.push(index + 1);
	}
	return offsets;
}

/**
 * Converts a string offset back to an LSP position.
 *
 * The character is a UTF-16 code-unit index, which is the JavaScript index, so
 * the result is exact for astral characters: an emoji two units before the
 * offset yields `character` two units past its start, which is what the
 * specification requires.
 */
export function offsetToPosition(text: string, offset: number): Position {
	const clamped = Math.max(0, Math.min(offset, text.length));
	const lineStart = lineStartOffsets(text);
	// Binary search for the last line start at or before the offset.
	let low = 0;
	let high = lineStart.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lineStart[mid] <= clamped) low = mid;
		else high = mid - 1;
	}
	return { line: low, character: clamped - lineStart[low] };
}

/** Extracts the text a range covers. */
export function rangeText(text: string, range: { start: Position; end: Position }): string {
	const start = positionToOffset(text, range.start);
	const end = positionToOffset(text, range.end);
	if (start === undefined || end === undefined || end < start) return "";
	return text.slice(start, end);
}

/**
 * The line and character of a character offset within a line, 1-based.
 *
 * For display only. Anything that must round-trip through a server uses
 * `positionToOffset` and `offsetToPosition` instead, because a 1-based
 * character is not a position.
 */
export function describeOffset(text: string, offset: number): { line: number; column: number } {
	const position = offsetToPosition(text, offset);
	return { line: position.line + 1, column: position.character + 1 };
}

/**
 * A workspace identity that is stable across worktrees and distinct between
 * them.
 *
 * Two delegated worktrees of one repository contain the same relative paths, and
 * a client that keyed documents by relative path would serve one tree's answers
 * for another's questions. Keying by the *absolute* URI makes that
 * impossible, and the `repositoryKey` is exposed so a caller can additionally
 * refuse cross-repository references.
 */
export interface WorkspaceIdentity {
	/** Absolute, normalized root. Distinct per worktree. */
	readonly root: string;
	/** `file://` form of the root, as a server sees it. */
	readonly rootUri: string;
	/** The repository this worktree belongs to, shared across worktrees. */
	readonly repositoryKey: string;
}

/** Builds a workspace identity for a root. */
export function workspaceIdentity(root: string, repositoryRoot?: string): WorkspaceIdentity {
	const absolute = isAbsolute(root) ? root : resolve(root);
	return {
		root: absolute,
		rootUri: pathToUri(absolute),
		// Two worktrees share a repository key; that is what lets a caller reject
		// a cross-worktree reference while still recognising both as the same
		// project.
		repositoryKey: repositoryRoot ? resolve(repositoryRoot) : absolute,
	};
}

/** True when `uri` is inside this workspace. */
export function isWithinWorkspace(identity: WorkspaceIdentity, uri: string): boolean {
	const path = uriToPath(uri);
	if (!path) return false;
	return (
		relative(identity.root, path) === "" ||
		(!relative(identity.root, path).startsWith("..") && !isAbsolute(relative(identity.root, path)))
	);
}

/** The workspace-relative form of a URI, for display. */
export function displayUri(identity: WorkspaceIdentity, uri: string): string {
	const path = uriToPath(uri);
	if (!path) return uri;
	const rel = relative(identity.root, path);
	return rel.length > 0 && !rel.startsWith("..") ? rel.split(sep).join("/") : uri;
}

/** Converts an absolute path to a `file://` URI. */
export function pathToUri(path: string): string {
	const absolute = isAbsolute(path) ? path : resolve(path);
	// The URL machinery encodes what a URI requires encoded, which is what keeps
	// `#`, `?`, spaces and percent signs in a filename from corrupting the URI. A
	// hand-built `file://` + path does not, and those characters are common in
	// real filenames.
	const slashed = absolute.replace(/\\/g, "/").replace(/^\/+/, "/");
	const url = new URL(`file://${encodeURI(slashed)}`);
	return url.href;
}

/** Converts a `file://` URI back to a path, or undefined for another scheme. */
export function uriToPath(uri: string): string | undefined {
	if (!uri.startsWith("file://")) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(uri);
	} catch {
		// A malformed escape is not a usable path. Returning undefined keeps a
		// hostile URI from becoming a filesystem probe.
		return undefined;
	}
	let pathname = decoded.slice("file://".length);
	// A local file URI's path begins immediately after the scheme. Anything else
	// carries an authority component, which names another host — so it does not
	// address this machine, and stripping the host would silently reinterpret a
	// remote path as a local one.
	if (pathname.indexOf("/") !== 0) return undefined;
	// Windows: a drive letter appears in a URI as `/C:/path`.
	if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
	return resolve(pathname);
}
