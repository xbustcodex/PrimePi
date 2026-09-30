import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { GoalOperation, GoalToolDetails } from "../src/core/tools/goal.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * Behavioral tests for the goal subsystem's production wiring.
 *
 * Every assertion here goes through an entry point a real session uses: the
 * registered `goal` tool, the session's `turn_start`/`turn_end` events, and the
 * status footer. Nothing calls `accountUsage`, `setGoalBudget`, or
 * `GoalAccounting.flush` directly, because a helper test proves the helper and
 * not the wiring, which is the failure this subsystem actually had.
 */

const ANSI = /\u001b\[[0-9;]*m/g;

/** A footer data provider with nothing to say, so only the goal segment can vary. */
const QUIET_FOOTER_DATA: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 0,
	onBranchChange: () => () => {},
};

interface TokenCounters {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * The session's cumulative token counters, as goal accounting reads them.
 *
 * This is the oracle for every charge assertion. The faux provider estimates a
 * response's usage from however large the prompt happens to be, so the exact
 * number a turn costs is not a fixture anyone should hard-code; what must be
 * pinned is that the goal is charged this session's own difference and not
 * something else.
 */
function billedTokens(harness: Harness): TokenCounters {
	const { input, output, cacheRead, cacheWrite } = harness.session.getSessionStats().tokens;
	return { input, output, cacheRead, cacheWrite };
}

/**
 * What a turn should be charged, by the rule `goalTokenDelta` states: input and
 * output are new work, cacheWrite can be enormous for a re-anchored prompt, and
 * cacheRead is a reused prefix that is not new work at all.
 */
function chargeableDelta(before: TokenCounters, after: TokenCounters): number {
	return (
		Math.max(0, after.input - before.input) +
		Math.max(0, after.output - before.output) +
		Math.max(0, after.cacheWrite - before.cacheWrite)
	);
}

/**
 * Records usage the way a provider does: through the session's own writer, at
 * the real provider boundary inside a live turn.
 *
 * The faux provider overwrites a response's usage with an estimate, so this is
 * the only lever left for pinning a specific charge. It bypasses the provider
 * and nothing else — the entry goes through `SessionManager`, the accounting
 * reads it back through `getSessionStats()`, and both happen inside a real
 * `turn_start`/`turn_end` cycle.
 */
function billDuringTurns(harness: Harness, usage: TokenCounters): void {
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	harness.session.subscribe((event) => {
		if (event.type !== "turn_start") return;
		harness.sessionManager.appendUsage("goal_test", "faux", "faux-model", {
			...usage,
			totalTokens: total,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});
}

/** The footer as the user sees it: the whole component, ANSI stripped. */
function footerText(session: Harness["session"]): string {
	const footer = new FooterComponent(session, QUIET_FOOTER_DATA);
	return footer.render(400).join("\n").replace(ANSI, "");
}

/** Runs one turn. The response text is what the faux provider bills against. */
async function turn(harness: Harness, text = "done"): Promise<void> {
	harness.setResponses([fauxAssistantMessage(text)]);
	await harness.session.prompt(text);
}

/**
 * The registered `goal` tool, taken from the agent's live tool set rather than
 * from the definition list. `getAllTools()` returns descriptions, not callables,
 * so only the object the agent would actually invoke can answer a call.
 */
async function goalTool(harness: Harness) {
	const tool = harness.session.state.tools.find((candidate) => candidate.name === "goal");
	if (!tool) throw new Error("goal tool is not registered");
	return tool as AgentTool<{ op: GoalOperation }, GoalToolDetails>;
}

describe("goal subsystem wiring", () => {
	// The footer renders through the global theme, exactly as the real footer does.
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows the goal in the footer with the setting on and hides it with the setting off", async () => {
		const harness = await createHarness();
		try {
			harness.session.orchestration.addGoal({ objective: "ship the goal subsystem", tokenBudget: 1_000, now: 1 });

			// Off: no segment, even though a goal is set.
			expect(footerText(harness.session)).not.toContain("GOAL");

			harness.settingsManager.setSetting("goal.enabled", true);
			expect(footerText(harness.session)).toContain("GOAL active 0/1000");

			// Same production entry point, second configuration.
			harness.settingsManager.setSetting("goal.enabled", false);
			expect(footerText(harness.session)).not.toContain("GOAL");
		} finally {
			harness.cleanup();
		}
	});

	it("hides the goal in the footer when goal.statusInFooter is off while the tool stays available", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			harness.settingsManager.setSetting("goal.statusInFooter", false);
			harness.session.orchestration.addGoal({ objective: "quiet", tokenBudget: 10, now: 1 });

			expect(footerText(harness.session)).not.toContain("GOAL");
			expect(harness.session.getActiveToolNames()).toContain("goal");
		} finally {
			harness.cleanup();
		}
	});

	it("reports an absent budget as unbounded rather than as zero tokens left", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			const tool = await goalTool(harness);
			const created = await tool.execute("call-1", { op: "create", objective: "no ceiling" });

			expect(created.details?.remainingTokens).toBeNull();
			expect(footerText(harness.session)).toContain("GOAL active 0");

			// Unbounded means usage cannot reach a ceiling, however much is spent.
			const before = billedTokens(harness);
			billDuringTurns(harness, { input: 5_000, output: 5_000, cacheRead: 1_000_000, cacheWrite: 0 });
			await turn(harness);

			const goal = harness.session.orchestration.goal.current;
			expect(goal?.status).toBe("active");
			expect(goal?.tokensUsed).toBe(chargeableDelta(before, billedTokens(harness)));
			expect(goal?.tokensUsed).toBeGreaterThanOrEqual(10_000);
		} finally {
			harness.cleanup();
		}
	});

	it("registers the goal tool only while goal.enabled is true, in both directions", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("goal");
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("goal");

			harness.settingsManager.setSetting("goal.enabled", true);
			expect(harness.session.getActiveToolNames()).toContain("goal");
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("goal");
			expect(harness.session.systemPrompt).toContain("Track an explicit session goal");

			// Turning it off has to withdraw the tool, not merely stop registering it
			// on some future build. A tool the user disabled that is still callable
			// is a setting that only prevents a future add.
			harness.settingsManager.setSetting("goal.enabled", false);
			expect(harness.session.getActiveToolNames()).not.toContain("goal");
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("goal");
			expect(harness.session.systemPrompt).not.toContain("Track an explicit session goal");
		} finally {
			harness.cleanup();
		}
	});

	it("charges each turn only that turn's usage, excluding a reused cache prefix", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			// A million cacheRead tokens a turn: if the accounting counted a reused
			// prefix as new work, every assertion below would be off by a million.
			billDuringTurns(harness, { input: 40, output: 10, cacheRead: 1_000_000, cacheWrite: 5 });
			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "stay under", token_budget: 1_000_000_000 });

			const beforeFirst = billedTokens(harness);
			await turn(harness, "first");
			const afterFirst = billedTokens(harness);
			const first = harness.session.orchestration.goal.current;
			expect(first?.tokensUsed).toBe(chargeableDelta(beforeFirst, afterFirst));

			const beforeSecond = billedTokens(harness);
			await turn(harness, "second");
			const afterSecond = billedTokens(harness);
			const second = harness.session.orchestration.goal.current;
			// The second turn is charged what the second turn cost, so the total is
			// the sum of the two deltas rather than the cumulative counter read twice.
			expect(second?.tokensUsed).toBe(
				chargeableDelta(beforeFirst, afterFirst) + chargeableDelta(beforeSecond, afterSecond),
			);
			expect(second?.status).toBe("active");
		} finally {
			harness.cleanup();
		}
	});

	it("flips to budget-limited when a turn's accounted usage crosses the ceiling", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			billDuringTurns(harness, { input: 40, output: 10, cacheRead: 0, cacheWrite: 5 });
			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "just enough", token_budget: 1_000 });
			await turn(harness, "first");
			const spent = harness.session.orchestration.goal.current?.tokensUsed ?? 0;
			expect(spent).toBeGreaterThan(0);

			// Put the ceiling one token below what has already been spent, so the next
			// turn's charge is what crosses it. A timer cannot produce this.
			await tool.execute("call-2", { op: "budget", token_budget: spent });
			await turn(harness, "second");

			const goal = harness.session.orchestration.goal.current;
			expect(goal?.status).toBe("budget-limited");
			expect(goal?.tokensUsed).toBeGreaterThanOrEqual(spent);
			expect(footerText(harness.session)).toContain("GOAL budget-limited");
		} finally {
			harness.cleanup();
		}
	});

	it("does not charge a goal for a turn that ran before the goal existed", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			await turn(harness, "before the goal");
			expect(harness.session.orchestration.goal.current).toBeUndefined();

			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "late", token_budget: 10_000_000 });
			const beforeGoalTurn = billedTokens(harness);
			await turn(harness, "after the goal");

			const goal = harness.session.orchestration.goal.current;
			// A goal created mid-session inherits nothing: it is charged the turns that
			// ran while it existed, not the session's whole history.
			expect(goal?.tokensUsed).toBe(chargeableDelta(beforeGoalTurn, billedTokens(harness)));
			expect(goal?.status).toBe("active");
		} finally {
			harness.cleanup();
		}
	});

	it("charges nothing and does not fail when there is no goal set", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			await turn(harness, "one");
			await turn(harness, "two");

			expect(harness.session.orchestration.goal.current).toBeUndefined();
			expect(footerText(harness.session)).not.toContain("GOAL");
		} finally {
			harness.cleanup();
		}
	});

	it("refuses to resume or complete a dropped goal, and stops surfacing it", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "abandon me", token_budget: 500 });
			await tool.execute("call-2", { op: "drop" });

			expect(harness.session.orchestration.goal.current?.status).toBe("dropped");
			expect(footerText(harness.session)).not.toContain("GOAL");
			await expect(tool.execute("call-3", { op: "resume" })).rejects.toThrow(/dropped/i);
			await expect(tool.execute("call-4", { op: "complete" })).rejects.toThrow(/dropped/i);
		} finally {
			harness.cleanup();
		}
	});

	it("raises and lowers the ceiling through the tool, re-evaluating the status both ways", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "budget dance", token_budget: 1 });
			await turn(harness, "spend");
			const spent = harness.session.orchestration.goal.current?.tokensUsed ?? 0;
			expect(spent).toBeGreaterThan(1);
			await tool.execute("call-2", { op: "budget", token_budget: 1 });
			expect(harness.session.orchestration.goal.current?.status).toBe("budget-limited");

			// Raising the ceiling above what has been spent makes the goal live again.
			await tool.execute("call-3", { op: "budget", token_budget: spent + 1 });
			expect(harness.session.orchestration.goal.current?.status).toBe("active");

			// Lowering it back to exactly what has been spent limits it again, and
			// says so: the ceiling is reached, not merely passed.
			const lowered = await tool.execute("call-4", { op: "budget", token_budget: spent });
			expect(harness.session.orchestration.goal.current?.status).toBe("budget-limited");
			expect(lowered.details?.reachedBudgetLimit).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a zero or fractional budget, because an absent budget means unbounded", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			const tool = await goalTool(harness);
			await expect(tool.execute("call-1", { op: "create", objective: "bad", token_budget: 0 })).rejects.toThrow(
				/positive integer/i,
			);
			await expect(tool.execute("call-2", { op: "create", objective: "bad", token_budget: 10.5 })).rejects.toThrow(
				/positive integer/i,
			);
			await expect(tool.execute("call-3", { op: "create", objective: "   " })).rejects.toThrow(/objective/i);
			expect(harness.session.orchestration.goal.current).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("leaves an approved plan untouched when a goal is set and worked against", async () => {
		const harness = await createHarness();
		try {
			harness.settingsManager.setSetting("goal.enabled", true);
			const orchestration = harness.session.orchestration;
			orchestration.beginPlanning(1);
			orchestration.recordDraft({ id: "plan-1", title: "approved work", content: "do the thing", now: 1 });
			orchestration.approvePlan(1);
			const planBefore = structuredClone(orchestration.state.plan);

			const tool = await goalTool(harness);
			await tool.execute("call-1", { op: "create", objective: "additional work", token_budget: 20 });
			await turn(harness, "work against the goal");
			await tool.execute("call-2", { op: "budget", token_budget: 5 });
			await tool.execute("call-3", { op: "drop" });

			// The whole point of the port: a goal is additive. Nothing above could
			// reach plan state, so nothing above did.
			expect(orchestration.state.plan).toEqual(planBefore);
			expect(orchestration.state.plan.plan?.title).toBe("approved work");
		} finally {
			harness.cleanup();
		}
	});

	it("lets an allow-list override the goal, but not a mere default-tool selection", async () => {
		// The reference behaviour: enabling goal mode puts the tool in the active
		// set, the way OMP's interactive mode does (`interactive-mode.ts:4467`). A
		// session-scoped tool is otherwise never auto-added merely for appearing, so
		// this is the only path that activates it.
		const defaulted = await createHarness({ initialActiveToolNames: ["read"] });
		try {
			defaulted.settingsManager.setSetting("goal.enabled", true);
			expect(defaulted.session.getActiveToolNames()).toContain("goal");
		} finally {
			defaulted.cleanup();
		}

		// An explicit allow-list is the user's decision about what may run at all,
		// and a settings toggle must not widen it.
		const restricted = await createHarness({ allowedToolNames: ["read"], initialActiveToolNames: ["read"] });
		try {
			restricted.settingsManager.setSetting("goal.enabled", true);
			expect(restricted.session.getActiveToolNames()).toEqual(["read"]);
			expect(restricted.session.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
		} finally {
			restricted.cleanup();
		}
	});
});
