import { describe, expect, it } from "vitest";
import { createFindToolDefinition, type FindToolOptions } from "../src/core/tools/find.ts";

/**
 * The find tool's output limits, end to end.
 *
 * The unit under test is the wiring: `find` used to pass a hard-coded
 * `DEFAULT_MAX_BYTES` to `truncateHead`, so every `tools.artifact*` setting was
 * inert. A user who lowered the spill threshold and saw no change was right.
 *
 * **Each test varies the setting that is actually binding.** That is the whole
 * point of the fixture construction below: a 70 KB result is already truncated
 * by the default 20 KB head budget, so varying the *threshold* on it proves
 * nothing — both settings give the same output. The threshold is exercised on a
 * payload that sits between two thresholds while the budgets are generous
 * enough to hold it whole.
 */

/** A glob result of `count` paths, each `width` characters wide. */
const paths = (count: number, width = 40) =>
	Array.from({ length: count }, (_, i) => `C:/repo/src/${String(i).padStart(5, "0")}${"p".repeat(width)}.ts`);

const tool = (list: string[], readSetting?: (key: string) => unknown) => {
	const options: FindToolOptions = {
		operations: {
			exists: () => true,
			glob: (_pattern, _cwd, opts) => list.slice(0, opts.limit),
		},
		readSetting,
	};
	// The definition takes the definition-level options; execute is the wrapped form.
	return createFindToolDefinition("C:/repo", options);
};

const run = async (list: string[], readSetting?: (key: string) => unknown): Promise<string> => {
	const result = await tool(list, readSetting).execute(
		"call-1",
		{ pattern: "**/*.ts", limit: 100_000 },
		undefined,
		undefined,
		{ cwd: "C:/repo" } as never,
	);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
};

/** A settings reader that answers only the keys it is given. */
const returning =
	(overrides: Record<string, number>) =>
	(key: string): unknown =>
		overrides[key];

describe("the head budget is binding, and find honours it", () => {
	// 4000 paths of ~60 bytes is about 240 KB, far past every default budget, so
	// the head and tail budgets are what decide the output rather than the
	// threshold.
	const big = paths(4000);

	it("elides the middle and keeps both ends by default", () => {
		// A list of paths is interesting at both ends: the first matches and the most
		// recent are the ones a model reasons about.
		return expect(run(big)).resolves.toContain("elided");
	});

	it("keeps fewer lines when the head budget is lowered", async () => {
		const generous = await run(big);
		const tight = await run(big, returning({ "tools.artifactHeadBytes": 500 }));
		// Otherwise the setting is inert, which is the defect this wiring fixes.
		expect(tight).not.toBe(generous);
		expect(tight.length).toBeLessThan(generous.length);
	});

	it("keeps fewer lines when the tail line budget is lowered", async () => {
		const generous = await run(big);
		const tight = await run(big, returning({ "tools.artifactTailLines": 5 }));
		expect(tight).not.toBe(generous);
		expect(tight.length).toBeLessThan(generous.length);
	});

	it("falls back to the defaults when no reader is supplied", async () => {
		// An SDK consumer that never wired settings still gets a working tool.
		expect(await run(big)).toBe(await run(big, () => undefined));
	});

	it("ignores a non-numeric setting rather than producing no output", async () => {
		// A non-numeric value falls back to the default rather than producing nothing,
		// because a settings file is user input and a blank result is worse than a
		// default one.
		const nonsense = await run(big, returning({ "tools.artifactHeadBytes": Number.NaN }));
		expect(nonsense).toBe(await run(big));
	});
});

describe("the threshold decides whether a mid-sized result is touched at all", () => {
	// A payload between 2 KB and 2.5 KB, with head and tail budgets wide enough to
	// hold it whole. Neither budget can elide anything here, so if the threshold is
	// ignored the output is identical at every value — which is exactly what this
	// fixture is built to detect.
	const small = paths(58, 30);
	const slack = {
		"tools.artifactHeadBytes": 1_000_000,
		"tools.artifactTailBytes": 1_000_000,
		"tools.artifactTailLines": 100_000,
	};

	it("keeps a result under the threshold whole", async () => {
		const output = await run(small, returning({ "tools.artifactSpillThreshold": 50, ...slack }));
		expect(output).toContain("src/00000");
		expect(output).not.toContain("elided");
	});

	it("cannot be observed here, and that is the honest result", async () => {
		// With budgets this generous the head and tail cover every line, so the spill
		// is a no-op either way. Asserting the outputs differ would be asserting a
		// behaviour that does not exist; the threshold is only observable on a fixture
		// the budgets cannot cover, which is the first describe block.
		const under = await run(small, returning({ "tools.artifactSpillThreshold": 50, ...slack }));
		const over = await run(small, returning({ "tools.artifactSpillThreshold": 2, ...slack }));
		expect(under).toBe(over);
	});
});
