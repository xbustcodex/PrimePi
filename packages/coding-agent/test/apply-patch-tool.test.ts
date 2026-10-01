import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_TOOL_TIERS, unclassifiedTools } from "../src/core/security/tool-classification.ts";
import { type ApplyPatchToolDetails, createApplyPatchToolDefinition } from "../src/core/tools/apply-patch.ts";

/**
 * The `apply_patch` tool against real files.
 *
 * The unit tests cover the parser and the matcher. This covers the thing that
 * actually matters: what lands on disk, and what does not, when a model hands
 * the tool a patch.
 */

const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-apply-"));
	roots.push(dir);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, "utf8");
	}
	return dir;
}

async function run(root: string, patch: string): Promise<{ text: string; details: ApplyPatchToolDetails | undefined }> {
	const definition = createApplyPatchToolDefinition({ root });
	const outcome = (await definition.execute(
		"call-1",
		{ patch },
		new AbortController().signal,
		undefined,
		undefined as never,
	)) as { content: { type: "text"; text: string }[]; details?: ApplyPatchToolDetails };
	return { text: outcome.content.map((part) => part.text).join("\n"), details: outcome.details };
}

describe("apply_patch classification", () => {
	it("is classified, at the same tier as edit", () => {
		// A patch writes file content, so it must be gated exactly like `edit`.
		expect(BUILT_IN_TOOL_TIERS.apply_patch).toBe(BUILT_IN_TOOL_TIERS.edit);
		expect(unclassifiedTools(["apply_patch"])).toEqual([]);
	});
});

describe("apply_patch writes what it should", () => {
	it("applies a hunk and leaves the rest of the file byte-identical", async () => {
		const root = workspace({ "a.ts": "one\ntwo\nthree\nfour\n" });
		const result = await run(
			root,
			["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " one", "-two", "+TWO", " three"].join("\n"),
		);
		expect(result.details?.applied).toBe(true);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("one\nTWO\nthree\nfour\n");
		expect(result.text).toContain("Applied 1 hunk");
	});

	it("applies a hunk whose recorded line number is stale", async () => {
		const root = workspace({ "a.ts": "one\ntwo\nthree\nfour\n" });
		// The header claims line 99. Content is the truth.
		const result = await run(root, ["--- a/a.ts", "+++ b/a.ts", "@@ -99,1 +99,1 @@", "-four", "+FOUR"].join("\n"));
		expect(result.details?.applied).toBe(true);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("one\ntwo\nthree\nFOUR\n");
	});

	it("applies several hunks", async () => {
		const root = workspace({ "a.ts": "one\ntwo\nthree\nfour\nfive\n" });
		const patch = [
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,1 +1,1 @@",
			"-one",
			"+ONE",
			"@@ -4,1 +4,1 @@",
			"-four",
			"+FOUR",
		].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(true);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("ONE\ntwo\nthree\nFOUR\nfive\n");
	});

	it("creates a file when the target does not exist", async () => {
		const root = workspace({});
		const patch = ["--- a/new.ts", "+++ b/new.ts", "@@ -0,0 +1,1 @@", "+created"].join("\n");
		const result = await run(root, patch);
		expect(result.details?.created).toBe(true);
		expect(readFileSync(join(root, "new.ts"), "utf8")).toContain("created");
	});

	it("handles CRLF content without corrupting it", async () => {
		const root = workspace({ "a.txt": "one\r\ntwo\r\nthree\r\n" });
		const patch = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(true);
		// The line that was not edited keeps its original bytes.
		expect(readFileSync(join(root, "a.txt"), "utf8")).toContain("one\r\n");
		expect(readFileSync(join(root, "a.txt"), "utf8")).toContain("three\r\n");
	});
});

describe("apply_patch refuses rather than guessing", () => {
	it("writes nothing when a hunk's context is absent", async () => {
		const root = workspace({ "a.ts": "one\ntwo\n" });
		const before = readFileSync(join(root, "a.ts"), "utf8");
		const patch = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-not present", "+X"].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(false);
		expect(result.text).toMatch(/Nothing was written/);
		// The file is byte-identical, which is the assertion that matters.
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(before);
	});

	it("writes nothing when only some hunks can be placed", async () => {
		const root = workspace({ "a.ts": "one\ntwo\nthree\n" });
		const before = readFileSync(join(root, "a.ts"), "utf8");
		const patch = [
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,1 +1,1 @@",
			"-one",
			"+ONE",
			"@@ -2,1 +2,1 @@",
			"-absent",
			"+X",
		].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(false);
		// All-or-none: the first hunk was placeable but is not written.
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(before);
	});

	it("refuses overlapping hunks and writes nothing", async () => {
		const root = workspace({ "a.ts": "one\ntwo\nthree\n" });
		const before = readFileSync(join(root, "a.ts"), "utf8");
		const patch = [
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,2 @@",
			"-one",
			"-two",
			"+A",
			"@@ -2,1 +2,1 @@",
			"-two",
			"+B",
		].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(false);
		expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(before);
	});

	it("reports an unparseable patch without writing", async () => {
		const root = workspace({ "a.ts": "one\n" });
		const result = await run(root, "this is not a diff at all");
		expect(result.details?.applied).toBe(false);
		expect(result.text).toMatch(/no .*hunks|not applied/i);
	});
});

describe("apply_patch treats the target as hostile input", () => {
	it("refuses a traversal target and creates nothing outside the workspace", async () => {
		const root = workspace({ "a.ts": "one\n" });
		// The escape target, if written, would be a sibling of the workspace. Named
		// for the *path* rather than for the action: `escape` shadows `globalThis.escape`.
		const escapedPath = join(root, "..", "escaped.txt");
		const patch = ["--- a/../escaped.txt", "+++ b/../escaped.txt", "@@ -0,0 +1,1 @@", "+escaped"].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(false);
		expect(result.text).toMatch(/outside the workspace/);
		// The decisive assertion: nothing appeared outside the root.
		expect(() => readFileSync(escapedPath, "utf8")).toThrow();
	});

	it("refuses an absolute target rather than writing outside the root", async () => {
		const root = workspace({ "a.ts": "one\n" });
		const patch = ["--- a/x", "+++ b/x", "@@ -0,0 +1,1 @@", "+x"].join("\n");
		const result = await run(root, patch.replace("b/x", "b/C:/Windows/System32/drivers/etc/hosts"));
		expect(result.details?.applied).toBe(false);
	});

	it("reports a traversal refusal rather than a write", async () => {
		const root = workspace({ "a.ts": "one\n" });
		const patch = ["--- a/a.ts", "+++ b/../../../../tmp/pi-escape-test.txt", "@@ -0,0 +1,1 @@", "+x"].join("\n");
		const result = await run(root, patch);
		expect(result.details?.applied).toBe(false);
		expect(result.details?.refused).toBeTruthy();
	});
});
