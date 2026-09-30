import { describe, expect, it } from "vitest";
import {
	classifyPromptLine,
	decideNudge,
	hasOpenQuestion,
	isMutatingTool,
	MID_RUN_NUDGE_MAX_PER_CYCLE,
	MID_RUN_NUDGE_MUTATION_THRESHOLD,
	type NudgeDecision,
} from "../src/core/todo/reminders.ts";

/**
 * Todo reminders.
 *
 * The property that matters most: the nudge must not fire while the **user** is
 * asking something. A model answering a question is working, and a nudge
 * interrupts an answer.
 */

const nudge = (overrides: Partial<Parameters<typeof decideNudge>[0]> = {}): NudgeDecision =>
	decideNudge({
		remindersEnabled: true,
		reminderLimit: 5,
		outstanding: 2,
		mutationsThisRun: MID_RUN_NUDGE_MUTATION_THRESHOLD,
		userAsking: false,
		turnEnded: true,
		nudgesThisCycle: 0,
		...overrides,
	});

describe("telling a question from a question mark", () => {
	it("recognises an ordinary question", () => {
		expect(classifyPromptLine("what is the retry policy?").isQuestion).toBe(true);
	});

	it("does not treat a type annotation as a question", () => {
		// The whole reason a corroborating test exists: `foo?: string` ends in `?`.
		const result = classifyPromptLine("the field is declared as foo?: string in the type");
		expect(result.isQuestion).toBe(false);
	});

	// Regression: the unmarked-opener branch used the full interrogative list, so
	// "do the work" read as a question. A reminder is suppressed whenever the
	// user is classified as mid-question, which meant the ordinary imperative
	// request — the most common prompt there is — silenced every reminder.
	it("does not treat an imperative as a question", () => {
		expect(classifyPromptLine("do the work").isQuestion).toBe(false);
		expect(classifyPromptLine("make it so").isQuestion).toBe(false);
		expect(classifyPromptLine("will check the logs").isQuestion).toBe(false);
	});

	// The narrow set is not so narrow that a genuine unmarked question is lost.
	it("still recognises an unmarked question fragment", () => {
		expect(classifyPromptLine("what about the pool").isQuestion).toBe(true);
		expect(classifyPromptLine("is the migration reversible").isQuestion).toBe(true);
	});

	it("does not treat a URL query as a question", () => {
		expect(classifyPromptLine("fetch https://example.test/search?q=what").isQuestion).toBe(false);
	});

	it("recognises a non-Latin question", () => {
		// No English word list catches this, but a non-ASCII character on a
		// `?`-terminated line reliably marks prose, and a code line is ASCII. A
		// non-Latin user waiting for an answer is the exact case at stake.
		expect(classifyPromptLine("这是什么？").isQuestion).toBe(true);
		expect(classifyPromptLine("¿Qué es esto?").isQuestion).toBe(true);
	});

	it("recognises a hand-back of a decision with no question mark", () => {
		// "please confirm" and "let me know" often carry no `?` at all.
		expect(classifyPromptLine("please confirm the approach").isQuestion).toBe(true);
		expect(classifyPromptLine("let me know which you prefer").isQuestion).toBe(true);
	});

	it("recognises a request phrased as a statement", () => {
		expect(classifyPromptLine("can you check the failing tests?").isQuestion).toBe(true);
	});

	it("strips a transcript label before deciding", () => {
		// A rendered `q2:` prefix is not part of the question, and a line that is
		// only a label is not a question at all.
		const withLabel = classifyPromptLine("q2: what should we do next?");
		expect(withLabel.isQuestion).toBe(true);
		expect(withLabel.text).toBe("what should we do next?");
	});

	it("strips markdown decoration", () => {
		expect(classifyPromptLine("> - what about the timeout?").isQuestion).toBe(true);
	});

	it("reports an empty line as empty rather than as a statement", () => {
		expect(classifyPromptLine("   ").reason).toBe("empty");
	});

	it("detects an open question anywhere in a transcript", () => {
		expect(hasOpenQuestion(["all done", "and the timeout?", "what about the pool"])).toBe(true);
		expect(hasOpenQuestion(["all done", "tests pass"])).toBe(false);
	});
});

describe("the nudge fires only when the agent has genuinely stopped", () => {
	it("nudges when the turn ended with work outstanding", () => {
		expect(nudge().nudge).toBe(true);
	});

	it("does not nudge while the turn is still running", () => {
		// An in-flight turn is working, not idle.
		expect(nudge({ turnEnded: false }).nudge).toBe(false);
	});

	it("does not nudge while the user is mid-question", () => {
		// The model is answering, which is also working.
		expect(nudge({ userAsking: true }).nudge).toBe(false);
	});

	it("does not nudge when the plan is complete", () => {
		expect(nudge({ outstanding: 0 }).nudge).toBe(false);
	});

	it("does not nudge when reminders are off", () => {
		expect(nudge({ remindersEnabled: false }).nudge).toBe(false);
	});

	it("does not nudge below the mutation threshold", () => {
		// No mutations and still going means reasoning, not finishing.
		expect(nudge({ mutationsThisRun: MID_RUN_NUDGE_MUTATION_THRESHOLD - 1 }).nudge).toBe(false);
	});

	it("does not nudge past the per-cycle limit", () => {
		// A nudge can prompt a turn, which can prompt another nudge.
		expect(nudge({ nudgesThisCycle: MID_RUN_NUDGE_MAX_PER_CYCLE }).nudge).toBe(false);
	});

	it("does not nudge a plan larger than the reminder limit", () => {
		// Reminding about a plan larger than the budget nags about work the
		// reminder was never meant to cover.
		expect(nudge({ outstanding: 10, reminderLimit: 5 }).nudge).toBe(false);
	});

	it("explains every refusal", () => {
		for (const overrides of [
			{ remindersEnabled: false },
			{ outstanding: 0 },
			{ turnEnded: false },
			{ userAsking: true },
			{ mutationsThisRun: 0 },
			{ nudgesThisCycle: 9 },
			{ outstanding: 99, reminderLimit: 1 },
		]) {
			const decision = nudge(overrides as Partial<Parameters<typeof nudge>[0]>);
			expect(decision.nudge, JSON.stringify(overrides)).toBe(false);
			expect(decision.reason.length, JSON.stringify(overrides)).toBeGreaterThan(5);
		}
	});
});

describe("mutation counting", () => {
	it("knows which tools change state", () => {
		expect(isMutatingTool("bash")).toBe(true);
		expect(isMutatingTool("edit")).toBe(true);
		expect(isMutatingTool("read")).toBe(false);
		expect(isMutatingTool("grep")).toBe(false);
	});
});
