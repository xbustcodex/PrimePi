/**
 * Associating a delegated task with a plan, goal, or TODO item.
 *
 * ## The constraint, restated
 *
 * Phase 4's founding invariant is that no code path exists between the plan, the
 * goal, and the todo list. This module respects that. It records a *reference*
 * and nothing else: an association is a tuple of existing identifiers, held
 * beside the orchestration state and never merged into it.
 *
 * Concretely, a task may say "this work implements todo item `X`" or "this
 * satisfies goal `G`". Nothing here writes to `PlanState`, `GoalState`, or
 * `TodoState`. A task cannot promote a todo to completed, cannot rewrite a goal's
 * objective, and cannot add steps to an approved plan — because there is no
 * function here that could.
 *
 * OMP's equivalent is `planReference` on `ExecutorOptions`, which the child
 * renders into its system prompt. That is a genuine coupling, and it is why this
 * port keeps the reference one-directional: the child may *read* an association,
 * never write one back.
 */

/** What a task is associated with. Every field is optional and read-only. */
export interface TaskAssociation {
	/** Plan id, when the task serves an approved plan. */
	planId?: string;
	/** The plan's title, for display. Not authoritative. */
	planTitle?: string;
	/** Goal id, when the task serves a goal. */
	goalId?: string;
	/** The todo item's verbatim content. Content is the identity, per Phase 4. */
	todoContent?: string;
}

/**
 * Renders an association for a child's prompt.
 *
 * Descriptive only, and deliberately phrased as context rather than authority:
 * the child is told what the work relates to, not what it may conclude about the
 * parent. A child must not be able to read "implements todo X" and treat it as
 * permission to mark X done.
 */
export function renderAssociationPrompt(association: TaskAssociation): string {
	const lines: string[] = [];
	if (association.planTitle) {
		lines.push(
			`This work relates to the approved plan "${association.planTitle}".`,
			"Follow the plan as guidance. Do not restate or rewrite it.",
		);
	}
	if (association.goalId) {
		lines.push(
			`This work serves goal ${association.goalId}.`,
			"Report progress toward it; do not redefine its objective or declare it complete.",
		);
	}
	if (association.todoContent) {
		lines.push(
			`This work corresponds to a tracked todo item: "${association.todoContent}".`,
			"Update the todo list through the todo tool; the parent owns that list.",
		);
	}
	return lines.join("\n");
}

/**
 * Builds an association from the current orchestration state.
 *
 * Read-only. A task associated with a *draft* plan records no `planId`, because
 * an unapproved draft is not authority — the same distinction Phase 4 drew
 * between `approved` and a draft, and the same one a child must respect.
 */
export function associationFor(input: {
	/** An approved plan, when the caller is acting under one. */
	approvedPlan?: { id: string; title: string };
	/** A goal id, when one is set. */
	goalId?: string;
	/** A todo item's verbatim content. */
	todoContent?: string;
}): TaskAssociation {
	return {
		...(input.approvedPlan ? { planId: input.approvedPlan.id, planTitle: input.approvedPlan.title } : {}),
		...(input.goalId ? { goalId: input.goalId } : {}),
		...(input.todoContent ? { todoContent: input.todoContent } : {}),
	};
}
