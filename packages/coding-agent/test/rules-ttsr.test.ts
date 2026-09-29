import { describe, expect, it } from "vitest";
import {
	DEFAULT_TTSR_SETTINGS,
	decideJudgedRule,
	decidePatternMatch,
	isRuleActive,
	type RuleContext,
	RuleFireTracker,
	shouldInterrupt,
	shouldJudge,
	type StreamRule,
	type TtsrSettings,
} from "../src/core/rules/ttsr.ts";

/**
 * Time Traveling Stream Rules.
 *
 * The property that defines the design: a **judged** rule never acts mid-stream.
 * Its condition is a question, and a question cannot be answered about a
 * half-written output — so it is asked about a completed one and delivered as a
 * warning that does not discard the turn.
 */

const patternRule: StreamRule = {
	id: "no-secrets",
	kind: "pattern",
	condition: "sk-ant-",
	message: "That looks like a credential. Do not paste it.",
};

const judgedRule: StreamRule = {
	id: "ran-tests",
	kind: "judged",
	question: "Did this reply claim the tests pass without running them?",
	message: "Claiming a passing test run without running one is unsupported.",
};

const settings = (overrides: Partial<TtsrSettings> = {}): TtsrSettings => ({
	...DEFAULT_TTSR_SETTINGS,
	enabled: true,
	...overrides,
});

const text: RuleContext = { source: "text" };
const tool: RuleContext = { source: "tool", toolName: "edit" };

describe("a rule is active only when the settings say so", () => {
	it("is inactive when rules are switched off entirely", () => {
		expect(isRuleActive(patternRule, settings({ enabled: false }))).toBe(false);
	});

	it("honours an individually disabled rule", () => {
		// A built-in rule the user switched off stays off even while the built-in
		// set is on.
		expect(isRuleActive(patternRule, settings({ disabledRules: ["no-secrets"] }))).toBe(false);
	});

	it("is inactive for a built-in rule when built-ins are off", () => {
		const builtin: StreamRule = { ...patternRule, builtin: true };
		expect(isRuleActive(builtin, settings({ builtinRules: false }))).toBe(false);
	});

	it("is inactive for a judged rule when judging is off", () => {
		expect(isRuleActive(judgedRule, settings({ judge: "off" }))).toBe(false);
	});

	it("is active otherwise", () => {
		expect(isRuleActive(patternRule, settings())).toBe(true);
	});
});

describe("interrupting a live stream", () => {
	it("interrupts prose and tool streams under always", () => {
		expect(shouldInterrupt("always", text)).toBe(true);
		expect(shouldInterrupt("always", tool)).toBe(true);
	});

	it("restricts prose-only to replies and reasoning", () => {
		expect(shouldInterrupt("prose-only", text)).toBe(true);
		expect(shouldInterrupt("prose-only", tool)).toBe(false);
	});

	it("restricts tool-only to tool arguments", () => {
		expect(shouldInterrupt("tool-only", tool)).toBe(true);
		expect(shouldInterrupt("tool-only", text)).toBe(false);
	});

	it("never interrupts under never", () => {
		expect(shouldInterrupt("never", text)).toBe(false);
		expect(shouldInterrupt("never", tool)).toBe(false);
	});
});

describe("a pattern match", () => {
	it("interrupts when the mode allows it", () => {
		const outcome = decidePatternMatch(patternRule, text, settings({ interruptMode: "always" }));
		expect(outcome.action).toBe("interrupt");
	});

	it("becomes a warning when interrupting is disabled", () => {
		// The rule stays useful without discarding tokens the model already spent.
		const outcome = decidePatternMatch(patternRule, text, settings({ interruptMode: "never" }));
		expect(outcome.action).toBe("warn");
	});

	it("is skipped entirely when the rule is disabled", () => {
		const outcome = decidePatternMatch(patternRule, text, settings({ disabledRules: ["no-secrets"] }));
		expect(outcome.action).toBe("skip");
	});
});

describe("a judged rule never acts mid-stream", () => {
	it("is skipped on partial output", () => {
		// A question cannot be answered about a half-written stream, and aborting a
		// turn to deliver a judgement about the half-written turn is the error.
		const outcome = decideJudgedRule(judgedRule, settings(), { completed: false });
		expect(outcome.action).toBe("skip");
		if (outcome.action !== "skip") return;
		expect(outcome.reason).toContain("completed output");
	});

	it("warns on a completed output", () => {
		// A warning, never an interrupt: the turn already happened, and discarding it
		// would throw away the work the judgement was about.
		const outcome = decideJudgedRule(judgedRule, settings(), { completed: true });
		expect(outcome.action).toBe("warn");
	});

	it("is skipped when judging is off", () => {
		expect(decideJudgedRule(judgedRule, settings({ judge: "off" }), { completed: true }).action).toBe("skip");
	});
});

describe("auto judging needs a judge to ask", () => {
	it("asks when auto and a judge role exists", () => {
		expect(shouldJudge(settings({ judge: "auto" }), true)).toBe(true);
	});

	it("does not ask under auto without a judge role", () => {
		// A session without a judge does not fail or stall; it simply does not judge.
		expect(shouldJudge(settings({ judge: "auto" }), false)).toBe(false);
	});

	it("asks when on and a judge role exists", () => {
		expect(shouldJudge(settings({ judge: "on" }), true)).toBe(true);
	});

	it("never asks when off", () => {
		expect(shouldJudge(settings({ judge: "off" }), true)).toBe(false);
	});
});

describe("a rule fires once, or after a gap", () => {
	it("fires once per session under once", () => {
		// A rule that re-fires every turn is not a rule, it is a loop the user has
		// to turn off.
		const tracker = new RuleFireTracker(settings({ repeatMode: "once" }));
		expect(tracker.canFire("r", 0)).toBe(true);
		tracker.record("r", 0);
		expect(tracker.canFire("r", 1)).toBe(false);
		expect(tracker.canFire("r", 500)).toBe(false);
	});

	it("fires again after the gap under after-gap", () => {
		const tracker = new RuleFireTracker(settings({ repeatMode: "after-gap", repeatGap: 10 }));
		expect(tracker.canFire("r", 0)).toBe(true);
		tracker.record("r", 5);
		expect(tracker.canFire("r", 10)).toBe(false);
		expect(tracker.canFire("r", 15)).toBe(true);
	});

	it("counts messages, not turns", () => {
		// A long single turn must not re-arm a rule that was meant to be spaced out.
		const tracker = new RuleFireTracker(settings({ repeatMode: "after-gap", repeatGap: 10 }));
		tracker.record("r", 0);
		expect(tracker.canFire("r", 9)).toBe(false);
		expect(tracker.canFire("r", 10)).toBe(true);
	});

	it("tracks rules independently", () => {
		const tracker = new RuleFireTracker(settings({ repeatMode: "once" }));
		tracker.record("a", 0);
		expect(tracker.canFire("b", 0)).toBe(true);
		expect(tracker.fired()).toEqual(["a"]);
	});

	it("forgets one rule or all of them", () => {
		const tracker = new RuleFireTracker(settings({ repeatMode: "once" }));
		tracker.record("a", 0);
		tracker.record("b", 0);
		tracker.reset("a");
		expect(tracker.canFire("a", 1)).toBe(true);
		expect(tracker.canFire("b", 1)).toBe(false);
		tracker.reset();
		expect(tracker.fired()).toEqual([]);
	});
});
