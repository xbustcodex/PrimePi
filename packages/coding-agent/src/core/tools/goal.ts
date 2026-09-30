/**
 * The `goal` tool: an explicit session goal with a token budget.
 *
 * ## Traced from OMP
 *
 * OMP's `GoalTool` (`goals/tools/goal-tool.ts`) exposes five operations —
 * create, get, complete, resume, drop — over a `GoalRuntime` the session owns.
 * The state half of that is `goal-state.ts` here; this file is the tool half, and
 * it is built to the same `ToolDefinition` shape as Pi's other session-scoped
 * tools (`todo.ts`), because a tool that is constructed from live session state
 * cannot come out of the cwd-only `createAllToolDefinitions` path.
 *
 * ## Deliberate divergences from OMP
 *
 * - **`pause` and `budget` exist here.** OMP drives both from interactive-mode
 *   chrome rather than the model. They are operations the goal state machine
 *   already implements (`setGoalStatus`, `setGoalBudget`), and exposing them
 *   through the one place a goal can be reached keeps a second control plane
 *   from growing.
 * - **No hidden steering message.** OMP sends a `goal-budget-limit` steer into
 *   the run when the budget runs out. PrimePi has no such prompt-rendering
 *   pipeline for goals, and inventing one would be a fabrication; the transition
 *   is observable in state and in the footer, which is where this port reports it.
 * - **Accounting is flushed, not owned.** `flushUsage` is injected. The tool can
 *   charge pending usage before a lifecycle change, but it never becomes the
 *   authority for usage — that stays with `GoalAccounting` on the session.
 *
 * ## The invariant this file exists to protect
 *
 * A goal is additive. Every operation here reads and writes `GoalState` and
 * nothing else, so adding work during implementation cannot rewrite an approved
 * plan — there is no reference to `PlanState` in this file to do it with.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	addGoal,
	dropGoal,
	type Goal,
	type GoalState,
	remainingTokens,
	setGoalBudget,
	setGoalStatus,
} from "../orchestration/goal-state.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** What the tool needs from its session. Injected, so no global state. */
export interface GoalOperations {
	get(): GoalState;
	set(state: GoalState): void;
	/**
	 * Charges usage accumulated so far against the current goal.
	 *
	 * Called before every lifecycle change so a budget that ran out mid-turn is
	 * not hidden by a pause, a completion, or a dropped goal.
	 */
	flushUsage(): void;
	now(): number;
}

const goalSchema = Type.Object({
	op: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("get"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("complete"),
			Type.Literal("drop"),
			Type.Literal("budget"),
		],
		{ description: "The operation to perform." },
	),
	objective: Type.Optional(Type.String({ description: "What the user asked for, verbatim. Required for op=create." })),
	token_budget: Type.Optional(
		Type.Number({
			description:
				"Token ceiling for the goal. Omit to make the goal unbounded; a bounded goal stops at the ceiling.",
		}),
	),
});

export type GoalParams = Static<typeof goalSchema>;

/** Operations the tool accepts. */
export type GoalOperation = GoalParams["op"];

/** The `details` payload, so a renderer can show the transition rather than the prose. */
export interface GoalToolDetails {
	op: GoalOperation;
	goal?: Goal;
	remainingTokens: number | null;
	/** Set only on the pass where accounted usage reached the ceiling. */
	reachedBudgetLimit?: boolean;
}

export const goalToolSystemPromptContribution = {
	snippet: "Track an explicit session goal against a token budget",
	guidelines: [
		"An objective added mid-task does not rewrite the plan the user approved; report against the goal you were given.",
		"A goal without a token budget is unbounded, not empty: omitting token_budget does not stop work.",
		"Only usage reaches the budget limit; time alone never does.",
	],
} as const;

/** Human-facing summary of a goal, mirroring the transcript wording of OMP's tool. */
export function formatGoalSummary(goal: Goal | undefined, reachedBudgetLimit = false): string {
	if (!goal) return "No goal set.";
	const lines = [`Goal: ${goal.objective}`, `Status: ${goal.status}`, `Tokens: ${goal.tokensUsed} used`];
	if (goal.tokenBudget !== undefined) {
		lines[lines.length - 1] += ` / ${goal.tokenBudget} budget`;
		const left = remainingTokens(goal);
		if (left !== null) lines.push(`Remaining tokens: ${left}`);
	}
	if (reachedBudgetLimit) lines.push("Budget limit reached from accounted usage.");
	return lines.join("\n");
}

/**
 * A budget must be a positive integer or absent.
 *
 * Rejects zero as loudly as a negative: an absent budget means unbounded, so a
 * zero budget would be a request for something the model cannot express — a goal
 * that is already exhausted before any work is done.
 */
function validateTokenBudget(tokenBudget: number | undefined): number | undefined {
	if (tokenBudget === undefined) return undefined;
	if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
		throw new Error("goal token_budget must be a positive integer when provided");
	}
	return tokenBudget;
}

/** Throws unless a goal exists. Used by every op that acts on one. */
function requireGoal(state: GoalState, op: GoalOperation): Goal {
	const goal = state.current;
	if (!goal) throw new Error(`cannot ${op} a goal because no goal is set`);
	return goal;
}

export function createGoalToolDefinition(
	operations: GoalOperations,
): ToolDefinition<typeof goalSchema, GoalToolDetails> {
	return {
		name: "goal",
		label: "Goal",
		description:
			"Track an explicit goal for this session against a token budget. Use create to set one, get to read it, pause and resume to suspend and continue it, budget to change the ceiling, complete when the objective is met, and drop to abandon it. A goal is additive: it never rewrites an approved plan.",
		promptSnippet: goalToolSystemPromptContribution.snippet,
		promptGuidelines: [...goalToolSystemPromptContribution.guidelines],
		parameters: goalSchema,
		// Tier is declared in `security/tool-classification.ts` rather than here:
		// `ToolDefinition` has no approval field, and the classification table is
		// the one place Pi's approval authority reads a tool's risk from.
		async execute(
			_toolCallId: string,
			params: GoalParams,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			_ctx?: ExtensionContext,
		): Promise<AgentToolResult<GoalToolDetails>> {
			const op = params.op;
			// Every lifecycle change charges the usage the goal already earned, so a
			// pause or a completion can never hide a budget that ran out.
			if (op !== "get") operations.flushUsage();

			let state = operations.get();
			let reachedBudgetLimit = false;

			if (op === "create") {
				const objective = params.objective?.trim();
				if (!objective) throw new Error("objective is required when op=create");
				state = addGoal(state, {
					objective,
					tokenBudget: validateTokenBudget(params.token_budget),
					now: operations.now(),
				});
			} else if (op === "pause") {
				requireGoal(state, op);
				state = setGoalStatus(state, "paused", operations.now());
			} else if (op === "resume") {
				const goal = requireGoal(state, op);
				if (goal.status === "complete") throw new Error("goal is already complete");
				// A dropped goal is terminal. Resuming it would re-surface work the
				// user abandoned, and its usage counters belong to a run that ended.
				if (goal.status === "dropped") throw new Error("cannot resume a dropped goal");
				state = setGoalStatus(state, "active", operations.now());
			} else if (op === "complete") {
				const goal = requireGoal(state, op);
				if (goal.status === "complete") throw new Error("goal is already complete");
				if (goal.status === "dropped") throw new Error("cannot complete a dropped goal");
				state = setGoalStatus(state, "complete", operations.now());
			} else if (op === "drop") {
				requireGoal(state, op);
				state = dropGoal(state, operations.now());
			} else if (op === "budget") {
				requireGoal(state, op);
				const before = state.current?.status;
				state = setGoalBudget(state, validateTokenBudget(params.token_budget), operations.now());
				reachedBudgetLimit = before !== "budget-limited" && state.current?.status === "budget-limited";
			}

			operations.set(state);
			const goal = state.current;
			return {
				content: [{ type: "text", text: formatGoalSummary(goal, reachedBudgetLimit) }],
				details: { op, goal, remainingTokens: remainingTokens(goal), reachedBudgetLimit },
			};
		},
	};
}

export function createGoalTool(operations: GoalOperations): AgentTool<typeof goalSchema, GoalToolDetails> {
	return wrapToolDefinition(createGoalToolDefinition(operations));
}
