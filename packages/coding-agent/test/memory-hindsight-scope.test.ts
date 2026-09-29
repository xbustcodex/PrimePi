import { describe, expect, it } from "vitest";
import {
	describeScoping,
	type HindsightConfig,
	isolationBetween,
	isInScope,
	resolveBankScope,
} from "../src/core/memory/hindsight-scope.ts";

/**
 * Hindsight bank scoping.
 *
 * The property that distinguishes the two isolating modes: `per-project` puts
 * the project in the **bank name**, so isolation does not depend on a recall
 * filter behaving correctly, while `per-project-tagged` filters and therefore
 * keeps surfacing untagged memories.
 */

const config = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	bankIdPrefix: "omp",
	scoping: "global",
	project: "app",
	...overrides,
});

describe("the three scopes", () => {
	it("global uses one shared bank and filters nothing", () => {
		const scope = resolveBankScope(config());
		expect(scope.bankId).toBe("omp");
		expect(scope.recallTags).toBeUndefined();
		expect(scope.retainTags).toBeUndefined();
	});

	it("per-project puts the project in the bank name", () => {
		// Hard isolation: the bank already decided, so this survives a bug in the
		// recall filter in a way tagging does not.
		const scope = resolveBankScope(config({ scoping: "per-project" }));
		expect(scope.bankId).toBe("omp-app");
		expect(scope.recallTags).toBeUndefined();
	});

	it("per-project-tagged shares the bank and tags both directions", () => {
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(scope.bankId).toBe("omp");
		expect(scope.retainTags).toEqual(["project:app"]);
		expect(scope.recallTags).toEqual(["project:app"]);
	});

	it("prefers an explicit bank id over the prefix", () => {
		expect(resolveBankScope(config({ bankId: "my-bank" })).bankId).toBe("my-bank");
	});

	it("falls back to omp when the prefix is blank", () => {
		expect(resolveBankScope(config({ bankIdPrefix: "   " })).bankId).toBe("omp");
	});
});

describe("tagged mode keeps untagged memories visible", () => {
	it("defaults the match to any, not all", () => {
		// A memory written before tagging existed has no tag. An `all` filter would
		// hide every pre-existing memory from a project that had been using the
		// service untagged, which is worse than occasionally surfacing a global one.
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(scope.recallTagsMatch).toBe("any");
	});

	it("treats an untagged memory as in scope under the default", () => {
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(isInScope(scope, {})).toBe(true);
		expect(isInScope(scope, { tags: [] })).toBe(true);
	});

	it("includes a memory tagged for this project", () => {
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(isInScope(scope, { tags: ["project:app"] })).toBe(true);
	});

	it("excludes a memory tagged for another project", () => {
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(isInScope(scope, { tags: ["project:other"] })).toBe(false);
	});

	it("includes a memory tagged for both projects", () => {
		// `any`: a global memory tagged for several projects belongs in each.
		const scope = resolveBankScope(config({ scoping: "per-project-tagged" }));
		expect(isInScope(scope, { tags: ["project:app", "project:other"] })).toBe(true);
	});

	it("excludes an untagged memory when the match is all", () => {
		const scope = { ...resolveBankScope(config()), recallTagsMatch: "all" as const, recallTags: ["project:app"] };
		expect(isInScope(scope, {})).toBe(false);
	});

	it("accepts everything when the scope does not tag", () => {
		// Hard isolation already decided; the bank would never have returned a
		// memory from elsewhere.
		const scope = resolveBankScope(config({ scoping: "per-project" }));
		expect(isInScope(scope, { tags: ["project:other"] })).toBe(true);
	});
});

describe("isolation strength", () => {
	const project = (overrides: Partial<HindsightConfig>) => config(overrides);

	it("is hard between two per-project scopes", () => {
		expect(isolationBetween(project({ scoping: "per-project" }), project({ scoping: "per-project" }))).toBe("hard");
	});

	it("is only tagged when a tag is involved", () => {
		expect(isolationBetween(project({ scoping: "per-project-tagged" }), project({ scoping: "per-project" }))).toBe(
			"tagged",
		);
	});

	it("is none when either side is global", () => {
		expect(isolationBetween(project({ scoping: "global" }), project({ scoping: "per-project" }))).toBe("none");
	});

	it("gives per-project scopes different bank ids", () => {
		const a = resolveBankScope(project({ scoping: "per-project", project: "a" })).bankId;
		const b = resolveBankScope(project({ scoping: "per-project", project: "b" })).bankId;
		expect(a).not.toBe(b);
	});
});

describe("each scope describes what it guarantees", () => {
	it("says global surfaces everything", () => {
		expect(describeScoping("global")).toContain("every memory");
	});

	it("says per-project isolates by bank, not by filter", () => {
		expect(describeScoping("per-project")).toContain("not by a recall filter");
	});

	it("says tagged mode still surfaces untagged memories", () => {
		expect(describeScoping("per-project-tagged")).toContain("Untagged memories still surface");
	});
});
