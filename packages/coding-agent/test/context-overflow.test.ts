import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorkspaceRoots,
	decideOverflow,
	isInside,
	promotionAvoidsCompaction,
	relativeToRoot,
} from "../src/core/context/overflow.ts";

/**
 * Context overflow and workspace roots.
 *
 * The properties that matter: the precedence is **defer, promote, compact**, and
 * compaction is last because it is the only option that loses information.
 */

const base = {
	pendingTokens: 250_000,
	contextWindow: 200_000,
	speculativeCompactionRunning: false,
	promotionEnabled: false,
};

describe("the three-way order", () => {
	it("defers to a maintenance pass already running", () => {
		// Compacting again would discard history the first pass is still summarising.
		const decision = decideOverflow({ ...base, speculativeCompactionRunning: true, promotionEnabled: true });
		expect(decision.action).toBe("defer");
	});

	it("defers before it promotes", () => {
		// The in-flight pass is the reason to wait, whatever else is available.
		const decision = decideOverflow({
			...base,
			speculativeCompactionRunning: true,
			promotionEnabled: true,
			largerModel: { id: "big", contextWindow: 400_000 },
		});
		expect(decision.action).toBe("defer");
	});

	it("promotes rather than compacting when a larger model fits", () => {
		// Promotion avoids compacting the history at all, which is strictly better:
		// the history stays whole and the model still sees all of it.
		const decision = decideOverflow({
			...base,
			promotionEnabled: true,
			largerModel: { id: "big", contextWindow: 400_000 },
		});
		expect(decision).toMatchObject({ action: "promote", model: "big" });
	});

	it("compacts when promotion is off", () => {
		expect(decideOverflow(base).action).toBe("compact");
	});

	it("compacts when there is no larger model", () => {
		// A promotion needs a model that is configured and usable; without one the
		// session compacts rather than failing.
		expect(decideOverflow({ ...base, promotionEnabled: true }).action).toBe("compact");
	});

	it("compacts when the larger model still cannot hold the request", () => {
		const decision = decideOverflow({
			...base,
			promotionEnabled: true,
			largerModel: { id: "small", contextWindow: 100_000 },
		});
		expect(decision.action).toBe("compact");
	});

	it("never fails the session on overflow", () => {
		// Every input resolves to an action; none rejects.
		for (const input of [base, { ...base, promotionEnabled: true }]) {
			expect(["defer", "promote", "compact", "none"]).toContain(decideOverflow(input).action);
		}
	});
});

describe("a promotion must actually escape the overflow", () => {
	it("needs both: the current model full and the candidate fitting", () => {
		expect(promotionAvoidsCompaction({ pendingTokens: 200_000, fromWindow: 200_000, toWindow: 400_000 })).toBe(true);
		// A "larger" model that still overflows is not an escape.
		expect(promotionAvoidsCompaction({ pendingTokens: 200_000, fromWindow: 200_000, toWindow: 100_000 })).toBe(false);
		// Promoting when nothing overflowed is a cost with no benefit.
		expect(promotionAvoidsCompaction({ pendingTokens: 10, fromWindow: 200_000, toWindow: 400_000 })).toBe(false);
	});
});

describe("workspace roots", () => {
	it("always includes the working directory", () => {
		// The roots are resolved, so they take the platform form: comparing against
		// a POSIX literal would be comparing against an accident of the machine.
		expect(buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: [] })).toEqual([
			{ path: path.resolve("/repo"), source: "cwd" },
		]);
	});

	it("resolves a relative directory against the working directory", () => {
		const roots = buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: ["../shared"] });
		expect(roots).toHaveLength(2);
		expect(roots[1]!.source).toBe("configured");
	});

	it("drops a root already inside another, rather than nesting it", () => {
		// Listing both duplicates search results and double-counts a path in every
		// relative reference.
		const roots = buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: ["/repo/src", "/repo"] });
		expect(roots).toHaveLength(1);
	});

	it("drops a root that contains the working directory", () => {
		const roots = buildWorkspaceRoots({ cwd: "/repo/app", additionalDirectories: ["/repo"] });
		expect(roots).toHaveLength(1);
	});

	it("keeps disjoint roots", () => {
		const roots = buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: ["/other", "/third"] });
		expect(roots.map((root) => root.path)).toEqual(["/repo", "/other", "/third"].map((entry) => path.resolve(entry)));
	});

	it("ignores a blank entry", () => {
		expect(buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: ["", "   "] })).toHaveLength(1);
	});
});

describe("path containment", () => {
	it("treats a directory as inside itself", () => {
		expect(isInside("/repo", "/repo")).toBe(true);
	});

	it("sees a nested path as inside its parent", () => {
		expect(isInside("/repo/src/a.ts", "/repo")).toBe(true);
	});

	it("does not treat a sibling prefix as inside", () => {
		// `/repository` is not inside `/repo`, and a naive startsWith gets this wrong.
		expect(isInside("/repository/a.ts", "/repo")).toBe(false);
	});

	it("normalises a trailing separator", () => {
		expect(isInside("/repo/src", "/repo/")).toBe(true);
	});
});

describe("paths are named by the root that holds them", () => {
	const roots = buildWorkspaceRoots({ cwd: "/repo", additionalDirectories: ["/shared"] });

	it("prefixes with the root name so two roots stay distinct", () => {
		const insideRepo = relativeToRoot(roots, "/repo/src/a.ts");
		const insideShared = relativeToRoot(roots, "/shared/lib.ts");
		// Two roots containing the same relative path must stay distinct in a
		// transcript.
		expect(insideRepo).toBe("repo/src/a.ts");
		expect(insideShared).toBe("shared/lib.ts");
	});

	it("returns nothing for a path outside every root", () => {
		expect(relativeToRoot(roots, "/elsewhere/a.ts")).toBeUndefined();
	});
});
