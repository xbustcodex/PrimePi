import { describe, expect, it } from "vitest";
import {
	createPlanReadMatcher,
	getReadToolPath,
	LOCAL_PLAN_ALIAS,
	mayBeginExecution,
	normalizePlanUrl,
	planFileName,
	type ProtectedToolContext,
	readTargetsPlan,
	resolvePlanFilePath,
	resolvePlanTitle,
} from "../src/core/plan/protection.ts";

/**
 * Plan-mode protection.
 *
 * The property that matters most: **a plan read with a selector must still be
 * recognised as a plan read.** Comparing raw strings would let
 * `local://PLAN.md:1-50` evade the very protection that exists to keep the plan
 * through compaction.
 */

function readContext(pathValue: string): ProtectedToolContext {
	return {
		toolResult: { toolName: "read" },
		toolCall: { name: "read", arguments: { path: pathValue } },
	};
}

describe("recognising a plan read", () => {
	it("normalises scheme spelling and read selectors", () => {
		expect(normalizePlanUrl("local:/PLAN.md")).toBe("local://PLAN.md");
		expect(normalizePlanUrl("local://PLAN.md:1-50")).toBe("local://PLAN.md");
		expect(normalizePlanUrl("  local://PLAN.md:raw  ")).toBe("local://PLAN.md");
	});

	it("matches the canonical alias with and without a selector", () => {
		expect(readTargetsPlan("local://PLAN.md", LOCAL_PLAN_ALIAS)).toBe(true);
		// The selector case is the one that would otherwise let a plan read evade its
		// own protection.
		expect(readTargetsPlan("local://PLAN.md:1-50", LOCAL_PLAN_ALIAS)).toBe(true);
	});

	it("matches the agent-chosen name the plan was saved under", () => {
		expect(readTargetsPlan("local://retry-budget-plan.md", "local://retry-budget-plan.md")).toBe(true);
		expect(readTargetsPlan("local://other-plan.md", "local://retry-budget-plan.md")).toBe(false);
	});

	it("does not match a different local document", () => {
		expect(readTargetsPlan("local://notes.md", LOCAL_PLAN_ALIAS)).toBe(false);
	});
});

describe("the protection matcher", () => {
	it("protects a plan read under either name", () => {
		const matcher = createPlanReadMatcher(() => "local://retry-budget-plan.md");
		expect(matcher(readContext("local://PLAN.md"))).toBe(true);
		expect(matcher(readContext("local://retry-budget-plan.md"))).toBe(true);
	});

	it("does not protect an unrelated read", () => {
		const matcher = createPlanReadMatcher(() => "local://retry-budget-plan.md");
		expect(matcher(readContext("local://src-index-plan.md"))).toBe(false);
		expect(matcher(readContext("skill://python"))).toBe(false);
	});

	it("ignores a call with no path", () => {
		const matcher = createPlanReadMatcher(() => "local://PLAN.md");
		expect(matcher({ toolResult: { toolName: "read" }, toolCall: { name: "read", arguments: {} } })).toBe(false);
		expect(matcher({ toolResult: { toolName: "read" }, toolCall: undefined })).toBe(false);
	});

	it("ignores a non-read tool even when the argument is a plan path", () => {
		const matcher = createPlanReadMatcher(() => "local://PLAN.md");
		expect(matcher({ toolResult: { toolName: "edit" }, toolCall: { name: "edit", arguments: { path: "local://PLAN.md" } } })).toBe(
			false,
		);
	});

	it("reads the reference path at match time, so a mid-session approval counts", () => {
		// Otherwise a plan approved during the session is unprotected until the next
		// restart, which is exactly the prune that loses it.
		let reference = "local://nothing-yet.md";
		const matcher = createPlanReadMatcher(() => reference);
		expect(matcher(readContext("local://fresh-plan.md"))).toBe(false);
		reference = "local://fresh-plan.md";
		expect(matcher(readContext("local://fresh-plan.md"))).toBe(true);
	});

	it("extracts a read path only from a paired read call", () => {
		expect(getReadToolPath(readContext("local://PLAN.md"))).toBe("local://PLAN.md");
		expect(getReadToolPath({ toolResult: { toolName: "read" }, toolCall: undefined })).toBeUndefined();
	});
});

describe("naming a saved plan", () => {
	it("derives a usable file name from a title", () => {
		expect(planFileName("Retry budget rework")).toBe("retry-budget-rework-plan.md");
	});

	it("produces a usable name for a title that is only punctuation", () => {
		// An approved plan has to have somewhere to live.
		expect(planFileName("!!!")).toBe("plan.md");
	});

	it("bounds the slug so a long title yields a valid path", () => {
		expect(planFileName("x".repeat(200)).length).toBeLessThanOrEqual(70);
	});

	it("resolves a path under the project directory", () => {
		// path.join uses the platform separator, so compare the segments rather than a
		// hardcoded POSIX string.
		expect(resolvePlanFilePath("/repo", "Retry budget").split(/[/\\]/)).toEqual([
			"",
			"repo",
			".omp",
			"plans",
			"retry-budget-plan.md",
		]);
	});
});

describe("where a title comes from", () => {
	it("prefers a supplied title", () => {
		expect(resolvePlanTitle({ suppliedTitle: "Given", planContent: "# Other", planFilePath: "/p/x-plan.md" })).toEqual({
			title: "Given",
			source: "supplied",
		});
	});

	it("falls back to the plan's own heading", () => {
		// The author's own name for it beats anything derived from the file it
		// happens to be saved under.
		expect(resolvePlanTitle({ planContent: "# Retry budget\nbody", planFilePath: "/p/x-plan.md" })).toEqual({
			title: "Retry budget",
			source: "content",
		});
	});

	it("falls back to the file name, never to an empty title", () => {
		expect(resolvePlanTitle({ planContent: "no heading", planFilePath: "/p/retry-budget-plan.md" })).toEqual({
			title: "retry-budget",
			source: "filename",
		});
		// Every plan in a project saving as plan.md would collide.
		expect(resolvePlanTitle({ planContent: "", planFilePath: "/p/plan.md" }).title).toBe("plan");
	});
});

describe("when execution may begin", () => {
	it("does not gate a session that never enabled plan mode", () => {
		// Otherwise the feature being off would leave every session stuck.
		expect(mayBeginExecution({ planModeEnabled: false, planModeActive: true, planApproved: false }).allowed).toBe(true);
	});

	it("does not gate a session not currently in plan mode", () => {
		expect(mayBeginExecution({ planModeEnabled: true, planModeActive: false, planApproved: false }).allowed).toBe(true);
	});

	it("gates an active plan awaiting approval", () => {
		const decision = mayBeginExecution({ planModeEnabled: true, planModeActive: true, planApproved: false });
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("not been approved");
	});

	it("releases an approved plan", () => {
		expect(mayBeginExecution({ planModeEnabled: true, planModeActive: true, planApproved: true }).allowed).toBe(true);
	});
});
