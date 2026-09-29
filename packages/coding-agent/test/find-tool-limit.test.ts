import { describe, expect, it } from "vitest";
import { createFindToolDefinition, type FindOperations } from "../src/core/tools/find.ts";

/**
 * The find tool's result-limit reporting.
 *
 * The property is **an exactly-full result set is not reported as truncated**.
 * The engine is over-fetched by one, and that extra row is the only evidence
 * that more matches exist. Without the over-fetch, a result set whose size
 * equals the limit is indistinguishable from a truncated one, and the tool
 * tells the model to widen a search that is already complete — which sends it
 * into a re-run that returns exactly the same complete list.
 */

/** A filesystem whose glob returns exactly the paths it is given. */
const opsReturning = (paths: string[]): FindOperations => ({
	exists: () => true,
	glob: (_pattern, _cwd, options) => {
		// Respecting the requested limit is the contract the real engines honour.
		return paths.slice(0, options.limit);
	},
});

const run = async (paths: string[], limit: number) => {
	const tool = createFindToolDefinition("C:/repo", { operations: opsReturning(paths) });
	// The find tool declares an ExtensionContext slot beyond the tool contract's
	// four parameters, so the call passes all five rather than relying on inference.
	const result = await tool.execute("call-1", { pattern: "**/*.ts", limit }, undefined, undefined, {
		cwd: "C:/repo",
	} as never);
	const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
	return { text, details: result.details as { resultLimitReached?: number } | undefined };
};

const files = (count: number) => Array.from({ length: count }, (_, index) => `C:/repo/src/file${index}.ts`);

describe("a complete result set is not reported as truncated", () => {
	it("says nothing about a limit when the result set is smaller", async () => {
		const { text, details } = await run(files(3), 10);
		expect(details?.resultLimitReached).toBeUndefined();
		expect(text).not.toContain("results limit reached");
	});

	it("says nothing when the result set is exactly the limit", async () => {
		// The bug: a set of exactly `limit` is complete, not truncated.
		const { text, details } = await run(files(5), 5);
		expect(details?.resultLimitReached).toBeUndefined();
		expect(text).not.toContain("results limit reached");
	});

	it("still reports the limit when more matches exist", async () => {
		const { text, details } = await run(files(20), 5);
		expect(details?.resultLimitReached).toBe(5);
		expect(text).toContain("results limit reached");
	});
});

describe("the over-fetch is what makes the check possible", () => {
	it("asks the engine for one more than the caller wants", async () => {
		const seen: number[] = [];
		const tool = createFindToolDefinition("C:/repo", {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => {
					seen.push(options.limit);
					return files(3).slice(0, options.limit);
				},
			},
		});
		await tool.execute("call-1", { pattern: "**/*.ts", limit: 5 }, undefined, undefined, { cwd: "C:/repo" } as never);
		// Without the extra row there is no evidence of whether more exist.
		expect(seen).toEqual([6]);
	});

	it("returns exactly the requested number, never the extra probe row", async () => {
		const { text } = await run(files(20), 5);
		const listed = text.split("\n").filter((line) => line.trim().startsWith("src/"));
		expect(listed).toHaveLength(5);
	});

	it("does not leak the probe row when it is the last one", async () => {
		// Six results, five wanted: the sixth is evidence only and must not appear.
		const { text } = await run(files(6), 5);
		expect(text).toContain("file4.ts");
		expect(text).not.toContain("file5.ts");
	});
});
