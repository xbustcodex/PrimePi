import { describe, expect, it } from "vitest";
import {
	EvalToolError,
	type EvalToolDescriptor,
	INTENT_FIELD,
	mergeEvalTools,
	renderEvalResult,
	resolveRequestedTools,
	schemaDeclaresIntentField,
	stripHarnessIntent,
} from "../src/eval-tools.ts";

/**
 * Eval-defined tools.
 *
 * This is a trust boundary: a tool defined in an eval cell runs with that
 * cell's privileges, and exposing it to a subagent hands those privileges to
 * code the subagent picks. So the properties are **the gate is explicit and
 * names itself**, and **a name comes from one kernel only** — two
 * implementations behind one name differ in arity, side effects and return
 * shape, and the caller cannot tell which one it reached.
 */

const py = (name: string, extra: Partial<EvalToolDescriptor> = {}): EvalToolDescriptor => ({
	name,
	language: "python",
	...extra,
});

const js = (name: string, extra: Partial<EvalToolDescriptor> = {}): EvalToolDescriptor => ({
	name,
	language: "js",
	...extra,
});

describe("a name may come from one kernel only", () => {
	it("rejects a name defined in both kernels", () => {
		// Failing here is the only point where the operator can still fix it.
		expect(() => mergeEvalTools([[py("search")], [js("search")]])).toThrow(EvalToolError);
	});

	it("names the collision and both kernels", () => {
		expect(() => mergeEvalTools([[py("search")], [js("search")]])).toThrow(/defined in both the Python and JS kernels/);
	});

	it("accepts distinct names from both kernels", () => {
		expect(mergeEvalTools([[py("search")], [js("summarise")]]).map((t) => t.name)).toEqual(["search", "summarise"]);
	});

	it("treats a same-language duplicate as one definition reported twice", () => {
		// Not a collision: it is the same function, and last-writer-wins is harmless.
		const merged = mergeEvalTools([[py("search"), py("search", { description: "second copy" })]]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.description).toBe("second copy");
	});

	it("returns nothing for no kernels", () => {
		expect(mergeEvalTools([])).toEqual([]);
		expect(mergeEvalTools([[], []])).toEqual([]);
	});
});

describe("the gate is explicit and names itself", () => {
	const available = [py("search")];

	it("refuses when eval tools are off", () => {
		expect(() => resolveRequestedTools(available, ["search"], { enabled: false })).toThrow(EvalToolError);
	});

	it("says which setting to change", () => {
		// "The feature is off" and "your tool is missing" need different fixes, so
		// returning an empty list would be the unhelpful answer here.
		expect(() => resolveRequestedTools(available, ["search"], { enabled: false })).toThrow(/eval\.tools\.enabled/);
	});

	it("allows the request when enabled", () => {
		expect(resolveRequestedTools(available, ["search"], { enabled: true }).map((t) => t.name)).toEqual(["search"]);
	});

	it("does not require the flag when nothing is requested", () => {
		expect(resolveRequestedTools(available, [], { enabled: false })).toEqual([]);
	});
});

describe("an unknown name is reported with what is available", () => {
	const available = [py("search"), py("index"), js("summarise")];

	it("names every missing tool", () => {
		expect(() => resolveRequestedTools(available, ["search", "nope", "alsonope"])).toThrow(/nope, alsonope/);
	});

	it("lists the available names, sorted", () => {
		// This text is read by a model deciding what to do next, so it has to be
		// stable between runs.
		expect(() => resolveRequestedTools(available, ["nope"])).toThrow(/Available: index, search, summarise/);
	});

	it("says none when nothing is defined", () => {
		expect(() => resolveRequestedTools([], ["nope"])).toThrow(/Available: none/);
	});

	it("ignores empty names rather than reporting them missing", () => {
		expect(resolveRequestedTools(available, ["search", ""]).map((t) => t.name)).toEqual(["search"]);
	});
});

describe("request order is the caller's", () => {
	it("answers in the order requested", () => {
		// The caller may be building an ordered prompt where position matters.
		const available = [py("a"), py("b"), py("c")];
		expect(resolveRequestedTools(available, ["c", "a", "b"]).map((t) => t.name)).toEqual(["c", "a", "b"]);
	});

	it("deduplicating preserves first occurrence", () => {
		const available = [py("a"), py("b")];
		expect(resolveRequestedTools(available, ["b", "a", "b"]).map((t) => t.name)).toEqual(["b", "a"]);
	});
});

describe("an intent field the schema does not declare is stripped", () => {
	const declared = { properties: { query: { type: "string" }, [INTENT_FIELD]: { type: "string" } } };
	const undeclared = { properties: { query: { type: "string" } } };

	it("detects a declared intent field", () => {
		expect(schemaDeclaresIntentField(declared)).toBe(true);
		expect(schemaDeclaresIntentField(undeclared)).toBe(false);
	});

	it("strips it when the schema does not declare it", () => {
		// Passing it through would send an argument the implementation never asked for.
		expect(stripHarnessIntent({ query: "x", [INTENT_FIELD]: "why" }, undeclared)).toEqual({ query: "x" });
	});

	it("keeps it when the schema declares it", () => {
		// There the author meant a parameter by that name.
		expect(stripHarnessIntent({ query: "x", [INTENT_FIELD]: "why" }, declared)).toMatchObject({ [INTENT_FIELD]: "why" });
	});

	it("leaves params without it untouched", () => {
		expect(stripHarnessIntent({ query: "x" }, undeclared)).toEqual({ query: "x" });
	});

	it("does not mutate the caller's object", () => {
		const params = { query: "x", [INTENT_FIELD]: "why" };
		stripHarnessIntent(params, undeclared);
		expect(params[INTENT_FIELD]).toBe("why");
	});

	it("treats a missing or malformed schema as declaring nothing", () => {
		expect(schemaDeclaresIntentField(undefined)).toBe(false);
		expect(schemaDeclaresIntentField({})).toBe(false);
		expect(schemaDeclaresIntentField({ properties: [] })).toBe(false);
	});
});

describe("result rendering", () => {
	it("passes a string through, and names an empty one", () => {
		expect(renderEvalResult("done")).toBe("done");
		expect(renderEvalResult("")).toBe("(empty result)");
	});

	it("names a nullish result rather than rendering blank", () => {
		expect(renderEvalResult(null)).toBe("(no result)");
		expect(renderEvalResult(undefined)).toBe("(no result)");
	});

	it("pretty-prints a structured result", () => {
		expect(renderEvalResult({ count: 2 })).toContain('"count": 2');
	});
});
