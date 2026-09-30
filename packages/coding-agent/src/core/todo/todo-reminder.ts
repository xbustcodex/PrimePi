/**
 * Todo reminders: the per-cycle state that turns a finished turn into a nudge.
 *
 * ## What is new here and what is not
 *
 * `reminders.ts` holds the *decisions* — `decideNudge` says whether a nudge is
 * warranted, and `hasOpenQuestion` says whether the user is mid-question. Both
 * are pure and both were written to be called from a live turn. This module is
 * the caller: it owns the counters a decision needs and renders the message the
 * model will read.
 *
 * A pure helper is not a reminder. What makes this a reminder is that a real
 * turn, through the session's turn-boundary hook, asks `evaluate` and, on a
 * yes, appends a message that the next provider request actually carries.
 *
 * ## The two counters, and why each exists
 *
 * - **Mutations this run.** `decideNudge` uses it to tell a model that has
 *   *stopped* from one that is still reasoning: a turn that changed nothing and
 *   ended is a model answering, not a model finishing. Counted across the run
 *   rather than since the last todo call, because at a turn boundary the "is it
 *   still working?" question is already settled — the turn ended.
 * - **Nudges this cycle.** A nudge produces a turn, and a turn can produce
 *   another nudge. Without a per-cycle budget that is a loop, and the loop
 *   would spend the user's tokens rather than their attention.
 *
 * Suppression for a turn that *touched* the plan is separate and local: the
 * caller passes `touchedPlanThisTurn`, because the model correcting its own plan
 * mid-run is working on it, and the loop's own continuation already re-enters
 * the provider for that turn. Counting mutations from the last todo call would
 * have bundled both concerns into one counter and made the turn-ended case
 * unreachable: a model that creates a plan and then answers has mutated nothing
 * *since* the plan, which is precisely the turn worth reminding about.
 *
 * ## The planning barrier is not this module's to lift
 *
 * `evaluate` returns `undefined` whenever the write barrier is up. A reminder
 * whose whole content is "keep working on these tasks" is a push toward
 * mutation, and during planning mutation is refused — so reminding then would
 * aim the agent at a wall the approval gate puts in front of it. The refusal
 * belongs to `planning-barrier.ts` and is expressed there; this only declines
 * to push against it.
 */

import { openTaskCount, type TodoState } from "../orchestration/todo-state.ts";
import { decideNudge, hasOpenQuestion, isMutatingTool } from "./reminders.ts";

/** The custom message type a reminder is persisted under. */
export const TODO_REMINDER_TYPE = "todo-reminder";

/** One still-open item, named so the UI can render it without re-deriving. */
export interface TodoReminderItem {
	readonly phase: string;
	readonly content: string;
	readonly status: string;
}

/** A reminder, ready to be appended to the transcript. */
export interface TodoReminder {
	/** The text the model reads. */
	readonly text: string;
	/** How many items are still open, for the UI. */
	readonly outstanding: number;
	/** Which reminder this is, 1-based, within the cycle. */
	readonly attempt: number;
	/** The per-cycle cap, so the UI can render "2/5". */
	readonly maxAttempts: number;
	/** The items still open, in phase order. */
	readonly items: readonly TodoReminderItem[];
}

/** What a caller must supply for one decision. */
export interface TodoReminderInput {
	/** Whether `todo.enabled` allows the todo subsystem at all. */
	readonly todosEnabled: boolean;
	/** Whether `todo.reminders` asks for reminders. */
	readonly remindersEnabled: boolean;
	/** `todo.remindersMax`: the largest plan worth nagging about. */
	readonly reminderLimit: number;
	/** The session's live todo state. */
	readonly todo: TodoState;
	/** Lines of the most recent user message. */
	readonly lastUserLines: readonly string[];
	/** Whether the planning barrier currently refuses writes. */
	readonly writeBarrierActive: boolean;
	/**
	 * Whether this turn's own tool results included a `todo` call.
	 *
	 * The model just worked on the plan, so it is mid-correction and the loop is
	 * already re-entering the provider for that turn.
	 */
	readonly touchedPlanThisTurn: boolean;
}

/**
 * Owns the per-cycle reminder state for one session.
 *
 * Deliberately free of session, agent, and UI references: the session supplies
 * the inputs and performs the append, so the whole budget can be exercised
 * without a provider.
 */
export class TodoReminderController {
	private mutationsThisRun = 0;
	private nudgesThisCycle = 0;

	/**
	 * Resets the per-cycle budgets.
	 *
	 * Called when a user turn begins, which is what makes the budget a *cycle*
	 * budget: a nudge can never survive into a new prompt the user wrote.
	 */
	beginCycle(): void {
		this.mutationsThisRun = 0;
		this.nudgesThisCycle = 0;
	}

	/**
	 * Records one tool result, before any decision reads the counters.
	 *
	 * Failures do not count: a tool that errored changed nothing, and a model
	 * whose last twelve calls all failed has not made progress either.
	 */
	noteToolResult(toolName: string, isError: boolean): void {
		if (!isError && isMutatingTool(toolName)) this.mutationsThisRun++;
	}

	/**
	 * Decides whether this turn ends with a reminder, and renders it.
	 *
	 * Returns `undefined` for every "no", including the ones no caller can act
	 * on: an empty list, a complete list, a plan larger than the limit, a user
	 * mid-question, a turn that just touched the plan, an exhausted budget, and
	 * the planning barrier.
	 */
	evaluate(input: TodoReminderInput): TodoReminder | undefined {
		if (input.writeBarrierActive) return undefined;
		if (input.touchedPlanThisTurn) return undefined;
		const outstanding = openTaskCount(input.todo);
		if (outstanding === 0) {
			// A finished plan resets the budget, so the next plan in this session is
			// not punished for reminders the previous one spent. The mutation count
			// is deliberately NOT reset here: on the first turn of a request there is
			// no plan yet, and clearing the run's progress at that moment is exactly
			// the turn where the model has just done the work the plan will describe.
			this.nudgesThisCycle = 0;
			return undefined;
		}

		const decision = decideNudge({
			remindersEnabled: input.todosEnabled && input.remindersEnabled,
			reminderLimit: input.reminderLimit,
			outstanding,
			mutationsThisRun: this.mutationsThisRun,
			userAsking: hasOpenQuestion(input.lastUserLines),
			turnEnded: true,
			nudgesThisCycle: this.nudgesThisCycle,
		});
		if (!decision.nudge) return undefined;

		this.nudgesThisCycle++;
		const items = openItems(input.todo);
		return {
			text: renderReminder(input.todo, items, this.nudgesThisCycle, input.reminderLimit),
			outstanding,
			attempt: this.nudgesThisCycle,
			maxAttempts: input.reminderLimit,
			items,
		};
	}
}

/** The items a reminder names: everything not completed or abandoned. */
function openItems(todo: TodoState): TodoReminderItem[] {
	const open: TodoReminderItem[] = [];
	for (const phase of todo.phases) {
		for (const task of phase.tasks) {
			if (task.status === "completed" || task.status === "abandoned") continue;
			open.push({ phase: phase.name, content: task.content, status: task.status });
		}
	}
	return open;
}

/**
 * The reminder text.
 *
 * States what is open and by how much, because a reminder that only says
 * "keep going" gives the model nothing to act on that the transcript does not
 * already say. The count leads, so a model reading only the first line still
 * knows the scale, and the phase grouping mirrors how the tool renders the list
 * so the two are recognisably the same plan.
 */
function renderReminder(
	todo: TodoState,
	items: readonly TodoReminderItem[],
	attempt: number,
	maxAttempts: number,
): string {
	const lines: string[] = [];
	for (const phase of todo.phases) {
		const inPhase = items.filter((item) => item.phase === phase.name);
		if (inPhase.length === 0) continue;
		lines.push(`- ${phase.name}`);
		for (const item of inPhase) lines.push(`  - ${item.content}`);
	}
	return [
		`<system-reminder>`,
		`You stopped with ${items.length} incomplete todo item(s):`,
		lines.join("\n"),
		"",
		`Continue working on these, or mark each one complete or abandoned.`,
		`Do not mark a task complete merely to silence this reminder; abandon it if it is genuinely no longer wanted.`,
		`(Reminder ${attempt}/${maxAttempts})`,
		`</system-reminder>`,
	].join("\n");
}
