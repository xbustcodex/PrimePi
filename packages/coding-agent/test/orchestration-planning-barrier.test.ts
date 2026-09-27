import { describe, expect, it } from "vitest";
import {
	approvePlan,
	beginPlanning,
	INITIAL_PLAN_STATE,
	recordDraft,
	rejectPlan,
} from "../src/core/orchestration/plan-state.ts";
import {
	classifyWriteTarget,
	extractWriteTargetPath,
	planningApprovalDeclaration,
} from "../src/core/orchestration/planning-barrier.ts";
import { decideToolApproval, toBeforeToolCallResult } from "../src/core/security/approval-gate.ts";

/**
 * The planning barrier, exercised through the real approval authority.
 *
 * The property under test is not "the barrier returns a deny". It is that a denial
 * produced by the barrier prevents the tool's `execute` from running — the
 * guarantee OMP lacks, where `bash` is unrestricted during plan mode because the
 * restriction lives inside `write`/`edit` rather than at a dispatch gate.
 *
 * Each test routes through `decideToolApproval`, which is what `beforeToolCall`
 * consumes. A `deny` there becomes `{ block: true }`, which the loop turns into an
 * immediate outcome, so `execute` is never reached.
 */

const T0 = 1_000_000;
const PREFIX = "plan://";
type Tier = "read" | "write" | "exec";
type Mode = "always-ask" | "write" | "yolo";

const PLANNING = beginPlanning(INITIAL_PLAN_STATE, T0);
const WITH_DRAFT = recordDraft(PLANNING, { title: "Add auth", content: "# Plan", now: T0 + 10 });
const APPROVED = approvePlan(WITH_DRAFT, T0 + 20);

/** Decides a call with the barrier applied, exactly as the session would. */
async function decide(name: string, tier: Tier, args: unknown, planState: typeof PLANNING, mode: Mode = "yolo") {
	const declaration = planningApprovalDeclaration({
		planState,
		baseDeclaration: tier,
		baseTier: tier,
		planArtifactPrefix: PREFIX,
		targetPath: extractWriteTargetPath(name, args),
	});
	const subject = declaration ? { name, approval: declaration } : { name, approval: tier };
	return decideToolApproval({ tool: subject as never, args, options: { mode, policies: {} } });
}

async function kindOf(name: string, tier: Tier, args: unknown, planState: typeof PLANNING, mode: Mode = "yolo") {
	const result = await decide(name, tier, args, planState, mode);
	return result.kind;
}

describe("write barrier while planning", () => {
	it("refuses a working-tree write", async () => {
		expect(await kindOf("write", "write", { path: "src/index.ts" }, PLANNING)).toBe("deny");
	});

	it("refuses an edit to the working tree", async () => {
		const args = { path: "src/index.ts", oldText: "a", newText: "b" };
		expect(await kindOf("edit", "write", args, PLANNING)).toBe("deny");
	});

	it("refuses shell execution outright, with no path to inspect", async () => {
		// OMP does not restrict bash during planning at all. Here it is `exec`, so
		// there is no target path to classify and nothing to talk past.
		expect(await kindOf("bash", "exec", { command: "rm -rf /" }, PLANNING)).toBe("deny");
	});

	it("refuses under every approval mode, including yolo", async () => {
		// A tool-declared deny, which Phase 3 guarantees no mode or user policy can
		// override.
		for (const mode of ["always-ask", "write", "yolo"] as const) {
			expect(await kindOf("write", "write", { path: "src/a.ts" }, PLANNING, mode)).toBe("deny");
		}
	});

	it("explains why in the refusal", async () => {
		const result = await decide("write", "write", { path: "src/a.ts" }, PLANNING);
		expect(result.kind).toBe("deny");
		if (result.kind !== "deny") throw new Error("expected a denial");
		expect(result.message).toMatch(/read-only while planning/);
	});
});

describe("read allowance while planning", () => {
	it("allows a read", async () => {
		expect(await kindOf("read", "read", { path: "src/a.ts" }, PLANNING)).toBe("allow");
	});

	it("allows exploration tools", async () => {
		for (const name of ["read", "ls", "grep", "find"]) {
			expect(await kindOf(name, "read", { path: "." }, PLANNING)).toBe("allow");
		}
	});

	it("allows reading the plan artifact", async () => {
		expect(await kindOf("read", "read", { path: `${PREFIX}add-auth` }, PLANNING)).toBe("allow");
	});
});

describe("the plan artifact stays writable", () => {
	it("allows writing the plan itself", async () => {
		expect(await kindOf("write", "write", { path: `${PREFIX}add-auth` }, PLANNING)).toBe("allow");
	});

	it("still refuses the working tree in the same mode", async () => {
		expect(await kindOf("write", "write", { path: "src/index.ts" }, PLANNING)).toBe("deny");
	});
});

describe("the barrier lifts only on approval", () => {
	it("still refuses under review", async () => {
		expect(await kindOf("write", "write", { path: "src/a.ts" }, WITH_DRAFT)).toBe("deny");
	});

	it("allows the working tree once approved", async () => {
		expect(await kindOf("write", "write", { path: "src/a.ts" }, APPROVED, "yolo")).toBe("allow");
	});

	it("still refuses after a rejection that keeps the draft", async () => {
		const rejected = rejectPlan(WITH_DRAFT, { now: T0 + 30, keepDraft: true });
		expect(await kindOf("write", "write", { path: "src/a.ts" }, rejected)).toBe("deny");
	});

	it("imposes nothing when no plan exists", async () => {
		expect(await kindOf("write", "write", { path: "src/a.ts" }, INITIAL_PLAN_STATE, "yolo")).toBe("allow");
	});
});

describe("the barrier produces a real block, not a warning", () => {
	it("converts a denial into the loop's blocking result", async () => {
		// `beforeToolCall` returning `{ block: true }` is what makes the loop return
		// an immediate outcome and skip `execute`. Returning `undefined` would let the
		// call proceed, which is the difference between a barrier and a note.
		const result = await decide("write", "write", { path: "src/a.ts" }, PLANNING);
		const blocked = await toBeforeToolCallResult(result);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toMatch(/read-only/);
	});

	it("produces no block when the call is allowed", async () => {
		const result = await decide("read", "read", { path: "src/a.ts" }, PLANNING);
		expect(await toBeforeToolCallResult(result)).toBeUndefined();
	});
});

describe("target classification fails toward the working tree", () => {
	it("recognizes the plan artifact prefix", () => {
		expect(classifyWriteTarget({ targetPath: `${PREFIX}x`, planArtifactPrefix: PREFIX })).toBe("plan-artifact");
	});

	it("treats relative and absolute paths as the working tree", () => {
		expect(classifyWriteTarget({ targetPath: "src/a.ts", planArtifactPrefix: PREFIX })).toBe("workspace");
		expect(classifyWriteTarget({ targetPath: "/etc/passwd", planArtifactPrefix: PREFIX })).toBe("workspace");
		expect(classifyWriteTarget({ targetPath: "../escape", planArtifactPrefix: PREFIX })).toBe("workspace");
	});

	it("treats an unknown scheme as not-writable rather than guessing", () => {
		// A novel URL scheme must not become a way to reach a write by being
		// unrecognized.
		expect(classifyWriteTarget({ targetPath: "weirdscheme://x", planArtifactPrefix: PREFIX })).toBe("unknown");
	});

	it("refuses an unclassifiable path", () => {
		const declaration = planningApprovalDeclaration({
			planState: PLANNING,
			baseDeclaration: "write",
			baseTier: "write",
			planArtifactPrefix: PREFIX,
			targetPath: "weirdscheme://x",
		});
		expect(declaration).toMatchObject({ policy: "deny" });
	});
});

describe("argument path extraction", () => {
	it("reads the common path argument names", () => {
		expect(extractWriteTargetPath("write", { path: "a" })).toBe("a");
		expect(extractWriteTargetPath("write", { file_path: "b" })).toBe("b");
		expect(extractWriteTargetPath("edit", { filePath: "c" })).toBe("c");
	});

	it("returns nothing for a shell, which is refused on tier alone", () => {
		expect(extractWriteTargetPath("bash", { command: "ls" })).toBeUndefined();
		expect(extractWriteTargetPath("powershell", { command: "ls" })).toBeUndefined();
	});

	it("returns nothing when no path argument is present", () => {
		expect(extractWriteTargetPath("write", { content: "x" })).toBeUndefined();
		expect(extractWriteTargetPath("write", undefined)).toBeUndefined();
	});
});
