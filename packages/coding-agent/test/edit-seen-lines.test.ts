import { describe, expect, it } from "vitest";
import { SeenLineIndex } from "../src/core/edit/seen-lines.ts";

/**
 * The seen-line guard.
 *
 * The property that makes the guard sound: **lines are recorded against a
 * content hash, not a path.** Keyed by path, any change would leave old lines
 * marked seen when they are no longer what the model read, and the guard would
 * wave through precisely the stale edit it exists to stop.
 */

const FILE = "/repo/src/index.ts";
const TEXT = ["line one", "line two", "line three", "line four", "line five"].join("\n");

describe("what counts as seen", () => {
	it("treats a whole-file read as seeing every line", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT);
		const decision = index.check({ absolutePath: FILE, tag, editLines: [1, 3, 5], enforce: true });
		expect(decision.allowed).toBe(true);
	});

	it("does not treat an unread file as fully seen", () => {
		// Defaulting to permissive would make the guard apply only to files someone
		// remembered to instrument, which is the opposite of a safety property.
		const index = new SeenLineIndex();
		const decision = index.check({ absolutePath: FILE, tag: "deadbeef", editLines: [1], enforce: true });
		expect(decision.allowed).toBe(false);
		expect(decision.unseenLines).toEqual([1]);
	});

	it("treats a partial read as seeing only those lines", () => {
		// A read with a line range displays some lines and not others, which is
		// exactly the case the guard exists for.
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT, [1, 2]);
		expect(index.check({ absolutePath: FILE, tag, editLines: [1], enforce: true }).allowed).toBe(true);
		const rejected = index.check({ absolutePath: FILE, tag, editLines: [4], enforce: true });
		expect(rejected.allowed).toBe(false);
		expect(rejected.unseenLines).toEqual([4]);
	});

	it("treats a grep that showed three lines as seeing three lines", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT, [2, 3]);
		expect(index.check({ absolutePath: FILE, tag, editLines: [2], enforce: true }).allowed).toBe(true);
		expect(index.check({ absolutePath: FILE, tag, editLines: [5], enforce: true }).allowed).toBe(false);
	});

	it("distinguishes an omitted line list from an empty one", () => {
		const index = new SeenLineIndex();
		// Omitted means the whole file was displayed; explicitly empty means
		// nothing was, which is a different statement.
		const whole = index.recordSnapshot(FILE, TEXT);
		expect(index.check({ absolutePath: FILE, tag: whole, editLines: [5], enforce: true }).allowed).toBe(true);
		const none = index.recordSnapshot("/repo/other.ts", TEXT, []);
		expect(index.check({ absolutePath: "/repo/other.ts", tag: none, editLines: [1], enforce: true }).allowed).toBe(
			false,
		);
	});

	it("reports every unseen line, not just the first", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT, [1]);
		const decision = index.check({ absolutePath: FILE, tag, editLines: [1, 3, 5], enforce: true });
		expect(decision.unseenLines).toEqual([3, 5]);
	});
});

describe("lines are recorded against content, not a path", () => {
	it("gives a different tag to the same bytes at a different path", () => {
		// A file moved or copied has its own provenance.
		const index = new SeenLineIndex();
		const a = index.recordSnapshot(FILE, TEXT);
		const b = index.recordSnapshot("/repo/other/copy.ts", TEXT);
		expect(a).not.toBe(b);
	});

	it("does not honour a read of different content at the same path", () => {
		// This is the failure the whole design turns on: the model read one version
		// and is editing another, so its line numbers refer to text that moved.
		const index = new SeenLineIndex();
		const oldTag = index.recordSnapshot(FILE, TEXT, [1, 2, 3, 4, 5]);
		const newText = ["rewritten", "line two", "line three"].join("\n");
		const newTag = index.recordSnapshot(FILE, newText, [1]);
		expect(index.check({ absolutePath: FILE, tag: newTag, editLines: [4], enforce: true }).allowed).toBe(false);
		// And the old tag still knows what it saw, so a model still reasoning about
		// the earlier text is not blocked for no reason.
		expect(index.check({ absolutePath: FILE, tag: oldTag, editLines: [4], enforce: true }).allowed).toBe(true);
	});

	it("gives a different tag to different content at the same path", () => {
		const index = new SeenLineIndex();
		expect(index.recordSnapshot(FILE, TEXT)).not.toBe(index.recordSnapshot(FILE, `${TEXT}\nline six`));
	});
});

describe("merging more displayed lines", () => {
	it("extends what a later read displayed", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT, [1]);
		expect(index.check({ absolutePath: FILE, tag, editLines: [2], enforce: true }).allowed).toBe(false);
		index.recordSeenLines(FILE, tag, [2, 3]);
		expect(index.check({ absolutePath: FILE, tag, editLines: [2, 3], enforce: true }).allowed).toBe(true);
	});

	it("ignores a merge for an unknown tag", () => {
		const index = new SeenLineIndex();
		expect(() => index.recordSeenLines(FILE, "nope", [1])).not.toThrow();
	});
});

describe("lookup and invalidation", () => {
	it("returns the current text and tag", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT);
		expect(index.headText(FILE)).toBe(TEXT);
		expect(index.headHash(FILE)).toBe(tag);
	});

	it("returns text for an older tag still held", () => {
		const index = new SeenLineIndex();
		const oldTag = index.recordSnapshot(FILE, "first");
		index.recordSnapshot(FILE, "second");
		expect(index.byHashText(FILE, oldTag)).toBe("first");
	});

	it("returns nothing for a path never recorded", () => {
		const index = new SeenLineIndex();
		expect(index.headText("/nowhere")).toBeNull();
		expect(index.headHash("/nowhere")).toBeNull();
		expect(index.seenLines("/nowhere", "x")).toBeNull();
	});

	it("moves a record on rename rather than losing it", () => {
		const index = new SeenLineIndex();
		const tag = index.recordSnapshot(FILE, TEXT, [1, 2, 3, 4, 5]);
		index.relocate(FILE, "/repo/src/renamed.ts");
		expect(index.headText(FILE)).toBeNull();
		expect(index.headText("/repo/src/renamed.ts")).toBe(TEXT);
		expect(index.check({ absolutePath: "/repo/src/renamed.ts", tag, editLines: [3], enforce: true }).allowed).toBe(
			true,
		);
	});

	it("forgets a path on invalidate", () => {
		const index = new SeenLineIndex();
		index.recordSnapshot(FILE, TEXT);
		index.invalidate(FILE);
		expect(index.headText(FILE)).toBeNull();
	});
});

describe("the guard can be switched off, and only it", () => {
	it("permits anything when disabled", () => {
		const index = new SeenLineIndex();
		const decision = index.check({ absolutePath: FILE, tag: "unknown", editLines: [1], enforce: false });
		expect(decision.allowed).toBe(true);
		expect(decision.unseenLines).toEqual([]);
		// The record is untouched, so switching it back on does not find a gap.
		expect(index.seenLines(FILE, "unknown")).toBeNull();
	});
});
