/**
 * Time Traveling Stream Rules: injecting a rule when the output matches it.
 *
 * ## What it is
 *
 * A rule carries a condition over the agent's output. When the output matches,
 * the rule is injected as a system reminder. The interesting part is *when* and
 * *how hard*, because injecting into a live stream means aborting work already
 * in flight.
 *
 * ## Two rule kinds, and they are not interchangeable
 *
 * A **pattern** rule matches the stream text directly, so a mid-stream match
 * means the model is currently doing the thing the rule forbids, and aborting it
 * is worth the lost work.
 *
 * A **judged** rule cannot match mid-stream at all. Its condition is a question
 * for a judge model, and a question cannot be answered about a half-written
 * stream. So the session asks about a *completed* output, and a yes is delivered
 * as a **non-interrupting warning** after the fact.
 *
 * Treating them the same is the design error this module exists to prevent: it
 * would abort a finished turn to deliver a judgement about the finished turn.
 */

/** What a match was found in. */
export type MatchSource = "text" | "thinking" | "tool";

/** When to interrupt a live stream rather than warn afterwards. */
export type InterruptMode = "never" | "prose-only" | "tool-only" | "always";

/** How often a rule may fire. */
export type RepeatMode = "once" | "after-gap";

/** How rules are judged. */
export type JudgeMode = "auto" | "on" | "off";

/** Whether a rule is matched by pattern or by asking a judge. */
export type RuleKind = "pattern" | "judged";

export interface StreamRule {
	readonly id: string;
	readonly kind: RuleKind;
	/** For a pattern rule, what the output must contain. */
	readonly condition?: string;
	/** For a judged rule, the question asked about a completed output. */
	readonly question?: string;
	/** The text injected when the rule fires. */
	readonly message: string;
	/** Built-in rules can be switched off individually. */
	readonly builtin?: boolean;
}

export interface TtsrSettings {
	readonly enabled: boolean;
	readonly judge: JudgeMode;
	readonly interruptMode: InterruptMode;
	readonly repeatMode: RepeatMode;
	/** Messages before a rule may fire again, under `after-gap`. */
	readonly repeatGap: number;
	/** Whether built-in rules are active. */
	readonly builtinRules: boolean;
	/** Rule ids the user has switched off. */
	readonly disabledRules: readonly string[];
}

export const DEFAULT_TTSR_SETTINGS: TtsrSettings = {
	enabled: false,
	judge: "auto",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
};

/** The output a rule is checked against. */
export interface RuleContext {
	readonly source: MatchSource;
	/** The tool name, for a tool-argument match. */
	readonly toolName?: string;
}

/** What should happen for one match. */
export type RuleOutcome =
	| { readonly action: "interrupt"; readonly rule: StreamRule; readonly reason: string }
	| { readonly action: "warn"; readonly rule: StreamRule; readonly reason: string }
	| { readonly action: "skip"; readonly reason: string };

/** Whether a rule is active under the settings. */
export function isRuleActive(rule: StreamRule, settings: TtsrSettings): boolean {
	if (!settings.enabled) return false;
	// A built-in rule the user switched off individually stays off, even while the
	// built-in set is on.
	if (settings.disabledRules.includes(rule.id)) return false;
	if (rule.builtin && !settings.builtinRules) return false;
	if (rule.kind === "judged" && settings.judge === "off") return false;
	return true;
}

/** Whether a match should interrupt a live stream. */
export function shouldInterrupt(mode: InterruptMode, context: RuleContext): boolean {
	switch (mode) {
		case "never":
			return false;
		case "always":
			return true;
		case "prose-only":
			// A reply or reasoning match is the model doing the thing now.
			return context.source === "text" || context.source === "thinking";
		case "tool-only":
			return context.source === "tool";
	}
}

/**
 * Decides what a pattern match does.
 *
 * A pattern match during a live stream aborts work, so the interrupt mode
 * decides whether that is worth it; a `never` mode converts the same match into
 * a warning delivered after completion, which keeps the rule useful without
 * discarding tokens the model already spent.
 */
export function decidePatternMatch(rule: StreamRule, context: RuleContext, settings: TtsrSettings): RuleOutcome {
	if (!isRuleActive(rule, settings)) {
		return { action: "skip", reason: "the rule is not active under the current settings" };
	}
	if (shouldInterrupt(settings.interruptMode, context)) {
		return { action: "interrupt", rule, reason: `matched in ${context.source} and the interrupt mode allows it` };
	}
	return {
		action: "warn",
		rule,
		reason: "matched, but interrupting is disabled, so the rule is delivered after completion",
	};
}

/**
 * Decides what a judged rule does.
 *
 * A judged rule is never applied mid-stream: its condition is a question, and a
 * question cannot be answered about a half-written output. The judge is asked
 * about a *completed* output, and a yes produces a warning that does not discard
 * the turn.
 */
export function decideJudgedRule(
	rule: StreamRule,
	settings: TtsrSettings,
	context: { readonly completed: boolean },
): RuleOutcome {
	if (!isRuleActive(rule, settings)) {
		return { action: "skip", reason: "judging is off, or the rule is disabled" };
	}
	if (!context.completed) {
		return {
			action: "skip",
			reason: "a judged rule needs a completed output, so it cannot act mid-stream",
		};
	}
	return { action: "warn", rule, reason: "the judge answered yes about a completed output" };
}

/** Whether a judge question should be asked at all. */
export function shouldJudge(settings: TtsrSettings, hasJudgeRole: boolean): boolean {
	if (settings.judge === "off") return false;
	// `auto` means "ask when a judge is available", so a session without a judge
	// role does not fail or stall; it simply does not judge.
	if (settings.judge === "auto") return hasJudgeRole;
	return hasJudgeRole;
}

/** Tracks how often each rule has fired. */
export class RuleFireTracker {
	readonly #lastFiredMessage = new Map<string, number>();
	readonly #settings: TtsrSettings;

	constructor(settings: TtsrSettings) {
		this.#settings = settings;
	}

	/**
	 * Whether a rule may fire now, given the current message index.
	 *
	 * `once` means a rule fires a single time per session: a rule that re-fires
	 * every turn is not a rule, it is a loop the user has to turn off.
	 */
	canFire(ruleId: string, currentMessage: number): boolean {
		const last = this.#lastFiredMessage.get(ruleId);
		if (last === undefined) return true;
		if (this.#settings.repeatMode === "once") return false;
		// `after-gap` counts messages, not turns, so a long single turn cannot
		// re-arm a rule that was meant to be spaced out.
		return currentMessage - last >= this.#settings.repeatGap;
	}

	/** Records that a rule fired. */
	record(ruleId: string, currentMessage: number): void {
		this.#lastFiredMessage.set(ruleId, currentMessage);
	}

	/** Rules that have fired at least once. */
	fired(): readonly string[] {
		return [...this.#lastFiredMessage.keys()];
	}

	/** Forgets a rule's history, so it may fire again. */
	reset(ruleId?: string): void {
		if (ruleId) this.#lastFiredMessage.delete(ruleId);
		else this.#lastFiredMessage.clear();
	}
}
