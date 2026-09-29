import { describe, expect, it } from "vitest";
import {
	DEFAULT_READ_SUMMARY,
	decideReadSummary,
	isProseSummaryPath,
	MAX_SUMMARY_BYTES,
	MAX_SUMMARY_LINES,
	type ReadSummarySettings,
	SUMMARY_CACHE_MAX,
	SummaryMemo,
	summaryCacheKey,
	unfoldBudget,
} from "../src/utils/read-summary.ts";

/**
 * Read summaries.
 *
 * Two properties carry this module. **A small file is read verbatim**, because
 * summarising it costs tokens to save tokens. And a **negative memo result costs
 * a boolean**, because the full result embeds the whole source in its kept
 * segments and caching successes would retain 48 near-2 MiB files to remember
 * what a `false` remembers just as well.
 */

const settings = (overrides: Partial<ReadSummarySettings> = {}): ReadSummarySettings => ({
	...DEFAULT_READ_SUMMARY,
	...overrides,
});

const file = (overrides: Partial<Parameters<typeof decideReadSummary>[0]> = {}) =>
	decideReadSummary({
		settings: settings(),
		filePath: "src/index.ts",
		totalLines: 500,
		bytes: 20_000,
		...overrides,
	});

describe("small files are read verbatim", () => {
	it("summarises a file above the threshold", () => {
		expect(file().action).toBe("summarize");
	});

	it("reads a small file whole", () => {
		// The summary of a forty-line file is nearly as long as the file, and the
		// model loses the ability to read the lines it came to read.
		const decision = file({ totalLines: 40 });
		expect(decision.action).toBe("verbatim");
		if (decision.action !== "verbatim") return;
		expect(decision.reason).toContain("below the summary threshold");
	});

	it("reads everything verbatim when summaries are off", () => {
		expect(file({ settings: settings({ enabled: false }) }).action).toBe("verbatim");
	});
});

describe("prose is not code", () => {
	it("recognises markdown and plain text", () => {
		expect(isProseSummaryPath("README.md")).toBe(true);
		expect(isProseSummaryPath("notes.txt")).toBe(true);
		expect(isProseSummaryPath("src/index.ts")).toBe(false);
	});

	it("is case-insensitive, because README.MD is still a document", () => {
		expect(isProseSummaryPath("README.MD")).toBe(true);
	});

	it("reads prose verbatim by default", () => {
		// A Markdown document has no signatures to summarise, so the result is an
		// outline of a document rather than its content.
		const decision = file({ filePath: "docs/guide.md" });
		expect(decision.action).toBe("verbatim");
		if (decision.action !== "verbatim") return;
		expect(decision.reason).toContain("prose");
	});

	it("summarises prose when opted in", () => {
		expect(file({ filePath: "docs/guide.md", settings: settings({ prose: true }) }).action).toBe("summarize");
	});
});

describe("a file too large to summarise is skipped", () => {
	it("refuses a very long file", () => {
		// Parsing a file this large costs more than the summary saves.
		const decision = file({ totalLines: MAX_SUMMARY_LINES + 1 });
		expect(decision.action).toBe("skip");
	});

	it("refuses a very large file", () => {
		expect(file({ bytes: MAX_SUMMARY_BYTES + 1 }).action).toBe("skip");
	});

	it("checks size before prose, so a huge document is not outlined", () => {
		// A large prose file summarised is a useless outline of a document the model
		// came to read.
		expect(file({ filePath: "docs/huge.md", totalLines: MAX_SUMMARY_LINES + 1 }).action).toBe("skip");
	});
});

describe("the memo key", () => {
	it("is stable for the same bytes and settings", () => {
		const content = new Uint8Array([1, 2, 3]);
		const first = summaryCacheKey({ content, filePath: "a.ts", settings: settings() });
		const second = summaryCacheKey({ content: content.slice(), filePath: "a.ts", settings: settings() });
		expect(first).toBe(second);
	});

	it("differs when the content differs", () => {
		const base = { filePath: "a.ts", settings: settings() };
		expect(summaryCacheKey({ ...base, content: new Uint8Array([1]) })).not.toBe(
			summaryCacheKey({ ...base, content: new Uint8Array([2]) }),
		);
	});

	it("differs when the fold settings differ", () => {
		// A summary produced at one threshold is not valid at another.
		const content = new Uint8Array([1, 2, 3]);
		expect(summaryCacheKey({ content, filePath: "a.ts", settings: settings() })).not.toBe(
			summaryCacheKey({ content, filePath: "a.ts", settings: settings({ minBodyLines: 10 }) }),
		);
	});

	it("differs when the path differs", () => {
		const content = new Uint8Array([1]);
		expect(summaryCacheKey({ content, filePath: "a.ts", settings: settings() })).not.toBe(
			summaryCacheKey({ content, filePath: "b.ts", settings: settings() }),
		);
	});
});

describe("a negative memo result costs a boolean", () => {
	it("records and reads back an unusable result", () => {
		// The full result embeds the whole source in its kept segments, so caching
		// successes would retain 48 near-2 MiB files to remember what false
		// remembers just as well.
		const memo = new SummaryMemo();
		memo.set("k", false);
		expect(memo.isKnownUnusable("k")).toBe(true);
		expect(memo.size).toBe(1);
	});

	it("distinguishes an unusable result from an absent one", () => {
		const memo = new SummaryMemo();
		expect(memo.isKnownUnusable("missing")).toBe(false);
		memo.set("missing", { kept: [] });
		expect(memo.isKnownUnusable("missing")).toBe(false);
	});

	it("stays bounded, evicting the oldest", () => {
		const memo = new SummaryMemo(3);
		for (let index = 0; index < 6; index++) memo.set(`k${index}`, false);
		// A miss re-parses, which is the cost the memo exists to avoid, not a
		// correctness problem.
		expect(memo.size).toBe(3);
		expect(memo.isKnownUnusable("k0")).toBe(false);
		expect(memo.isKnownUnusable("k5")).toBe(true);
	});

	it("has a sane default capacity", () => {
		expect(SUMMARY_CACHE_MAX).toBeGreaterThan(1);
	});
});

describe("unfolding is bounded twice", () => {
	it("honours the smaller of the request, the target and the ceiling", () => {
		const configured = settings({ unfoldUntil: 2_000, unfoldLimit: 1_000 });
		expect(unfoldBudget(500, configured)).toBe(500);
		// Past the ceiling.
		expect(unfoldBudget(5_000, configured)).toBe(1_000);
		// Past the target, with a larger ceiling.
		expect(unfoldBudget(5_000, settings({ unfoldUntil: 2_000, unfoldLimit: 9_000 }))).toBe(2_000);
	});

	it("treats a non-positive request as nothing rather than everything", () => {
		expect(unfoldBudget(0, settings())).toBe(0);
		expect(unfoldBudget(-5, settings())).toBe(0);
		expect(unfoldBudget(Number.NaN, settings())).toBe(0);
	});
});
