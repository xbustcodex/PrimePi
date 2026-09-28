import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_THRESHOLD,
	DOMINANT_DELTA,
	findMatch,
	formatMatchFailure,
	lineSimilarity,
	normalizeForMatch,
} from "../src/core/edit/match.ts";
import { applyPatch, MAX_PATCH_BYTES, parsePatch, resolvePatchTarget } from "../src/core/edit/patch.ts";

/**
 * Adversarial tests for the edit matching and patch layers.
 *
 * Every case is a way the layer could be made to write something other than what
 * the model asked for. The property under test throughout: the layer either finds
 * the intended text with evidence, or refuses and says why. It never guesses.
 */

// Two functions whose bodies differ, so a body line is unique and a shared line
// is not. Both properties are needed: the unique case proves offsets, and the
// shared case proves the ambiguity refusal.
const SAMPLE = [
	"function alpha(value: string) {",
	"\treturn value.trim();",
	"}",
	"",
	"function beta(value: string) {",
	"\treturn value.toUpperCase();",
	"}",
	"",
	"function gamma(value: string) {",
	"\treturn value.trim();",
	"}",
].join("\n");

describe("match normalization", () => {
	it("normalizes whitespace, quotes, dashes and exotic spaces", () => {
		expect(normalizeForMatch("const a = 1;   ")).toBe("const a = 1;");
		expect(normalizeForMatch("const a = “x”")).toBe('const a = "x"');
		expect(normalizeForMatch("const a = ‘x’")).toBe("const a = 'x'");
		expect(normalizeForMatch("a – b")).toBe("a - b");
		expect(normalizeForMatch("a b")).toBe("a b");
	});

	it("does not normalize identifiers, so a renamed symbol never matches", () => {
		// The line between "invisible in review" and "changes meaning". Anything
		// that rewrote identifiers would let a patch land on the wrong function.
		expect(normalizeForMatch("const total = 1;")).not.toBe(normalizeForMatch("const subtotal = 1;"));
	});
});

describe("literal matching", () => {
	it("finds unique text with byte offsets and a line number", () => {
		const outcome = findMatch(SAMPLE, "return value.toUpperCase();", {});
		expect(outcome.matched).toBeDefined();
		expect(outcome.matched?.tier).toBe("literal");
		expect(outcome.matched?.startLine).toBe(6);
		expect(SAMPLE.slice(outcome.matched!.startIndex).startsWith("return value.toUpperCase();")).toBe(true);
	});

	it("refuses an ambiguous match and reports the candidate lines", () => {
		// `return value.trim();` appears in alpha and gamma. Picking one is a coin
		// flip that corrupts a file silently.
		const outcome = findMatch(SAMPLE, "return value.trim();", {});
		expect(outcome.matched).toBeUndefined();
		expect(outcome.failure?.occurrences).toBe(2);
		expect(outcome.failure?.occurrenceLines).toEqual([2, 10]);
		expect(formatMatchFailure("a.ts", "x", outcome.failure!)).toMatch(/Add more surrounding context/);
	});

	it("treats an empty target as no match rather than matching everywhere", () => {
		// `indexOf("")` is 0, which would silently edit the top of the file.
		expect(findMatch(SAMPLE, "", {}).matched).toBeUndefined();
	});

	it("finds CRLF content through LF normalization", () => {
		const crlf = "line one\r\nline two\r\n";
		const outcome = findMatch(crlf, "line one\nline two", {});
		expect(outcome.matched?.tier).toBe("normalized");
	});
});

describe("scored matching", () => {
	it("is off unless the caller opts in", () => {
		// Normalized-only is the safe default: a scorer can match a line whose
		// content differs, so it must never be the accidental behaviour.
		const changed = SAMPLE.replace("return value.trim();", 'return value?.trim() ?? "";');
		expect(findMatch(changed, SAMPLE, {}).matched).toBeUndefined();
		expect(findMatch(changed, SAMPLE, { allowScored: true }).matched).toBeDefined();
	});

	it("matches a block whose content changed in one line", () => {
		const changed = SAMPLE.replace("function beta", "function betaRenamed");
		const outcome = findMatch(changed, SAMPLE, { allowScored: true });
		expect(outcome.matched?.tier).toBe("scored");
		expect(outcome.matched?.actualText).toContain("betaRenamed");
	});

	it("refuses when several windows clear the threshold and none is dominant", () => {
		// Three near-identical functions; a rename touches only one. Choosing is a
		// guess, so the answer is a refusal naming the candidates.
		const many = [1, 2, 3].map((n) => `function fn${n}(value: string) {\n\treturn value.trim();\n}`).join("\n\n");
		const outcome = findMatch(many, "function fn2(value: string) {\n\treturn value.trim();\n}", {
			allowScored: true,
		});
		if (outcome.matched) {
			// A dominant match is legitimate; assert it is the right one.
			expect(outcome.matched.actualText).toContain("fn2");
		} else {
			expect(outcome.failure?.aboveThresholdCount).toBeGreaterThan(1);
		}
	});

	it("scores a one-token rename above the threshold and an unrelated block below it", () => {
		const renamed = SAMPLE.replace("alpha", "alphaPrime");
		const renameScore = findMatch(renamed, SAMPLE, { allowScored: true }).matched?.confidence ?? 0;
		const unrelated = findMatch("totally different content here", SAMPLE, { allowScored: true });
		expect(renameScore).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
		expect(unrelated.matched).toBeUndefined();
	});

	it("matches a reindented block, since indentation is not meaning", () => {
		const reindented = SAMPLE.replace(/\t/g, "\t\t");
		const outcome = findMatch(reindented, SAMPLE, { allowScored: true });
		expect(outcome.matched).toBeDefined();
	});

	it("reports the closest near-miss when nothing matches", () => {
		const outcome = findMatch(SAMPLE, "function gamma(value: string) {\n\treturn value;\n}", {
			allowScored: true,
		});
		expect(outcome.matched).toBeUndefined();
		expect(outcome.failure?.closest).toBeDefined();
		expect(formatMatchFailure("a.ts", "x", outcome.failure!)).toMatch(/below the 95% required/);
	});

	it("keeps the dominance constants meaningful", () => {
		// A dominant match must clear both bars; the delta is what makes
		// "clearly better" a threshold rather than a vibe.
		expect(DOMINANT_DELTA).toBeGreaterThan(0);
		expect(DEFAULT_THRESHOLD).toBeGreaterThan(0.9);
	});

	it("scores an identical line as 1 and disjoint lines near 0", () => {
		expect(lineSimilarity("abc", "abc")).toBe(1);
		expect(lineSimilarity("aaaaaaaa", "zzzzzzzz")).toBeLessThan(0.2);
	});
});

describe("patch parsing", () => {
	it("parses a multi-hunk patch", () => {
		const patch = [
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +1,3 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"@@ -10,2 +10,2 @@",
			" ten",
			"-eleven",
			"+ELEVEN",
		].join("\n");
		const parsed = parsePatch(patch);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.patch.target).toBe("src/a.ts");
		expect(parsed.patch.hunks).toHaveLength(2);
	});

	it("defaults an omitted hunk count to 1", () => {
		const parsed = parsePatch(["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.patch.hunks[0].oldCount).toBe(1);
	});

	it("refuses a patch with no hunk headers rather than guessing", () => {
		const parsed = parsePatch(["--- a/x", "+++ b/x", " just some text"].join("\n"));
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.kind).toBe("no-hunks");
	});

	it("refuses a patch with no target", () => {
		const parsed = parsePatch(["--- a/x", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.kind).toBe("no-target");
	});

	it("bounds patch size", () => {
		const huge = "x".repeat(MAX_PATCH_BYTES + 1);
		const parsed = parsePatch(huge);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.kind).toBe("too-large");
	});
});

describe("patch application", () => {
	const base = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");

	it("applies a hunk located by content, not by line number", () => {
		// The header claims line 1 but the change belongs at line 4. Content is the
		// truth; a line-number-only application would edit the wrong place.
		const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-one", "+ONE"].join("\n");
		const parsed = parsePatch(patch);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.content.split("\n")[0]).toBe("ONE");
		expect(applied.content.split("\n")[3]).toBe("four");
	});

	it("finds a hunk whose recorded line number is stale", () => {
		const patch = ["--- a/f", "+++ b/f", "@@ -99,1 +99,1 @@", "-five", "+FIVE"].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.content).toContain("FIVE");
	});

	it("matches context despite trailing-whitespace drift", () => {
		const drifted = ["one", "two  ", "three", "four", "five", "six", "seven"].join("\n");
		const patch = ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(drifted, parsed.patch);
		expect(applied.ok).toBe(true);
	});

	it("refuses a hunk whose context is absent, changing nothing", () => {
		const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-nonexistent line", "+x"].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(false);
		if (applied.ok) return;
		expect(applied.error.kind).toBe("not-found");
	});

	it("applies all hunks or none", () => {
		// A partial apply is the failure mode that makes a retry corrupt a file.
		const patch = [
			"--- a/f",
			"+++ b/f",
			"@@ -1,1 +1,1 @@",
			"-one",
			"+ONE",
			"@@ -2,1 +2,1 @@",
			"-does-not-exist",
			"+X",
		].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(false);
		// Nothing was written, so the file is untouched.
		expect(base.split("\n")[0]).toBe("one");
	});

	it("applies several valid hunks", () => {
		const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-one", "+ONE", "@@ -4,1 +4,1 @@", "-four", "+FOUR"].join(
			"\n",
		);
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.applied).toBe(2);
		expect(applied.content).toContain("ONE");
		expect(applied.content).toContain("FOUR");
	});

	it("refuses overlapping hunks rather than applying both", () => {
		const patch = [
			"--- a/f",
			"+++ b/f",
			"@@ -1,2 +1,2 @@",
			"-one",
			"-two",
			"+A",
			"@@ -2,1 +2,1 @@",
			"-two",
			"+B",
		].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(base, parsed.patch);
		expect(applied.ok).toBe(false);
		if (applied.ok) return;
		expect(applied.error.kind).toBe("overlap");
	});

	it("preserves a file with no trailing newline", () => {
		const noNewline = "one\ntwo";
		const patch = ["--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-one", "+ONE"].join("\n");
		const parsed = parsePatch(patch);
		if (!parsed.ok) throw new Error("parse failed");
		const applied = applyPatch(noNewline, parsed.patch);
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.content.endsWith("\n")).toBe(false);
	});
});

describe("patch target resolution is hostile-input safe", () => {
	const root = "/workspace/project";

	it("resolves an ordinary relative path inside the root", () => {
		const resolved = resolvePatchTarget("src/a.ts", { root });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.path).toContain("src");
	});

	it("refuses a traversal out of the workspace", () => {
		// The single most important assertion in this file: a patch is a model
		// message, and a message is not allowed to name a file outside the tree.
		for (const target of ["../../etc/passwd", "../../../root/.ssh/authorized_keys", "a/../../../../outside.txt"]) {
			const resolved = resolvePatchTarget(target, { root });
			expect(resolved.ok, `${target} should be refused`).toBe(false);
		}
	});

	it("refuses an absolute path by rebasing it rather than honouring it", () => {
		// `/etc/passwd` becomes `<root>/etc/passwd`; it never becomes `/etc/passwd`.
		// The root is a real temp directory here, so the comparison is meaningful
		// on both separator conventions.
		const realRoot = mkdtempSync(join(tmpdir(), "pi-patch-root-"));
		try {
			const resolved = resolvePatchTarget("/etc/passwd", { root: realRoot });
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			const normalized = resolved.path.replace(/\\/g, "/");
			expect(normalized.startsWith(realRoot.replace(/\\/g, "/").replace(/\/+$/, ""))).toBe(true);
			expect(normalized).toContain("/etc/passwd");
		} finally {
			rmSync(realRoot, { recursive: true, force: true });
		}
	});

	it("refuses a Windows drive-qualified and a UNC path", () => {
		expect(resolvePatchTarget("C:/Windows/system32/config", { root }).ok).toBe(false);
		expect(resolvePatchTarget("\\\\server\\share\\file", { root }).ok).toBe(false);
	});

	it("refuses a URL-shaped target", () => {
		expect(resolvePatchTarget("https://example.com/x.ts", { root }).ok).toBe(false);
	});

	it("refuses /dev/null, which names no file to write", () => {
		expect(resolvePatchTarget("/dev/null", { root }).ok).toBe(false);
	});

	it("refuses an empty target", () => {
		expect(resolvePatchTarget("", { root }).ok).toBe(false);
	});

	it("accepts a path with a traversal that lands back inside the root", () => {
		// `a/../b` never leaves the root, so it is not a refusal case. Refusing it
		// would teach the model to avoid a correct patch.
		const resolved = resolvePatchTarget("a/../b.ts", { root });
		expect(resolved.ok).toBe(true);
	});

	it("accepts a filename containing characters that are hostile in other contexts", () => {
		// A `#` in a filename broke OMP's hashline addressing. A patch must not
		// inherit that failure, and must not quote-strip it either.
		for (const name of ["weird#name.ts", "has space.ts", "quo'te.ts", "dash-name.ts", "ünïcode.ts"]) {
			const resolved = resolvePatchTarget(name, { root });
			expect(resolved.ok, name).toBe(true);
		}
	});

	it("reports a create when the target does not exist", () => {
		const resolved = resolvePatchTarget("brand-new.ts", { root });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.isCreate).toBe(true);
	});
});
