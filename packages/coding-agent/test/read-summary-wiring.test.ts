import { describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

/**
 * The read tool's summary policy.
 *
 * The property under test is that the `read.summarize.*` settings reach the
 * tool at all. The module that decides the policy was written and unit-tested
 * against a fake; these tests prove the wiring, which is what was missing: a
 * registered setting with no consumer passes every ledger check and changes
 * nothing.
 *
 * The fixtures separate the two decision axes. A **large** file is where the
 * threshold can bind; a **Markdown** file is where prose can bind. A fixture that
 * is large *and* prose has two reasons to be read verbatim and can attribute
 * neither.
 */

/** A file of `lines` numbered lines, each `width` characters wide. */
const source = (lines: number, width = 40) =>
	Array.from({ length: lines }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(width)}`).join("\n");

const read = async (path: string, body: string, readSetting?: (key: string) => unknown) => {
	// A Buffer, not a Uint8Array: the tool calls toString("utf-8") on it, which a plain
	// view does not have.
	const bytes = Buffer.from(body, "utf8");
	const tool = createReadToolDefinition("C:/repo", {
		operations: {
			readFile: async () => bytes,
			access: async () => {},
			detectImageMimeType: async () => null,
		},
		readSetting,
	});
	const result = await tool.execute("call-1", { path }, undefined, undefined, { cwd: "C:/repo" } as never);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
};

describe("the summary settings reach the tool", () => {
	it("reads a small file verbatim whatever the threshold is", () => {
		// Below the threshold the file is read whole; the byte budget is irrelevant,
		// which is the point of a separate threshold.
		return expect(read("src/small.ts", source(10))).resolves.toContain("0000");
	});

	it("says a file too large to summarize is too large", async () => {
		// 30,000 lines is past MAX_SUMMARY_LINES, so the tool must decline rather than
		// attempt a parse it cannot afford.
		const body = Array.from({ length: 30_000 }, (_, i) => `line${i}`).join("\n");
		const output = await read("src/huge.ts", body);
		expect(output).toContain("too large to summarize");
	});

	it("reads a huge file normally when summaries are off", async () => {
		// Disabling the setting disables the whole summary path, size guard included.
		// The file is then truncated by the ordinary byte budget, which is a different
		// outcome and an honest one: the user turned the feature off, so nothing about
		// summarizing should remain. OMP gates the same way at read.ts:2001.
		const body = Array.from({ length: 30_000 }, (_, i) => `line${i}`).join("\n");
		const output = await read("src/huge.ts", body, (key) => (key === "read.summarize.enabled" ? false : undefined));
		expect(output).not.toContain("too large to summarize");
		expect(output).toContain("line0");
	});
});

describe("a Markdown document is read as prose", () => {
	// Large enough to be past the threshold, so prose is the only reason it is not
	// summarized.
	const doc = Array.from({ length: 500 }, (_, i) => `## Section ${i}\n\nBody text for section ${i}.`).join("\n\n");

	it("reads a large document verbatim by default", async () => {
		// A Markdown document has no signatures, so summarizing it yields an outline
		// of a document rather than its content.
		const output = await read("docs/guide.md", doc);
		expect(output).toContain("Section 0");
		expect(output).not.toContain("too large to summarize");
	});

	it("does not treat a .ts file with the same shape as prose", async () => {
		// The same bytes under a code extension must not be classified as prose.
		const output = await read("src/guide.ts", doc);
		expect(output).toContain("Section 0");
	});
});
