import { describe, expect, it } from "vitest";
import type { Api, Model, ThinkingLevel } from "../src/types.ts";
import {
	AUTO_THINKING,
	clampThinkingLevelForModel,
	concreteThinkingLevel,
	INHERIT_THINKING,
	isThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	supportedThinkingLevels,
	THINKING_LEVELS,
} from "../src/utils/thinking-level.ts";

/**
 * Thinking level: parsing, the three representations, and clamping.
 *
 * The property that matters most is that a requested level the model does not
 * support becomes a *lower* one the model does support, and never a level above
 * the request or a silent drop to nothing.
 */

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: "claude",
		api: "anthropic-messages",
		cost: { input: 1, output: 1 },
		limit: { context: 200_000, output: 8_000 },
		reasoning: true,
		...overrides,
	} as Model<Api>;
}

describe("parsing", () => {
	it("accepts every level", () => {
		// The shared list carries `off` as well, and `off` is a configured value
		// rather than a level, so it is not parsed as one.
		for (const level of THINKING_LEVELS) {
			expect(parseThinkingLevel(level)).toBe(level === "off" ? undefined : level);
		}
		expect(parseThinkingLevel("off")).toBeUndefined();
		expect(parseConfiguredThinkingLevel("off")).toBe("off");
	});

	it("accepts unambiguous abbreviations", () => {
		// Every selector surface parses alike, so `--thinking xhi` and a role value
		// of `xhi` mean the same thing.
		expect(parseThinkingLevel("xhi")).toBe("xhigh");
		expect(parseThinkingLevel("med")).toBe("medium");
	});

	it("refuses a single letter, which would be a guess", () => {
		// `m` is ambiguous across medium, minimal and max, and a wrong guess
		// silently changes how hard the model thinks.
		expect(parseThinkingLevel("m")).toBeUndefined();
		expect(parseThinkingLevel("x")).toBeUndefined();
	});

	it("refuses a genuinely ambiguous abbreviation", () => {
		// Only `m` is ambiguous here: minimal, medium and max all start with it.
		expect(parseThinkingLevel("m")).toBeUndefined();
		// `mi` is not - only minimal starts with it - and refusing it would make the
		// two-character minimum do nothing useful.
		expect(parseThinkingLevel("mi")).toBe("minimal");
		expect(parseThinkingLevel("ma")).toBe("max");
	});

	it("is case-insensitive and tolerates whitespace", () => {
		expect(parseThinkingLevel("  HIGH ")).toBe("high");
	});

	it("parses the sentinels as configured values, not levels", () => {
		expect(parseConfiguredThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel(INHERIT_THINKING)).toBe(INHERIT_THINKING);
		expect(parseConfiguredThinkingLevel("off")).toBe("off");
		// They are not levels, and treating one as a level would send the literal
		// string to a provider.
		expect(parseThinkingLevel("auto")).toBeUndefined();
		expect(parseThinkingLevel("inherit")).toBeUndefined();
	});
});

describe("the three representations", () => {
	it("turns auto and inherit into nothing on the wire", () => {
		// Both mean "someone else decides", and the request layer expresses that
		// as absent rather than as a literal.
		expect(concreteThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(concreteThinkingLevel(INHERIT_THINKING)).toBeUndefined();
		expect(concreteThinkingLevel(undefined)).toBeUndefined();
		expect(concreteThinkingLevel("off")).toBeUndefined();
		expect(concreteThinkingLevel("high")).toBe("high");
	});

	it("treats off as a deliberate instruction, not an absence", () => {
		expect(shouldDisableReasoning("off")).toBe(true);
		expect(shouldDisableReasoning("high")).toBe(false);
		expect(shouldDisableReasoning(undefined)).toBe(false);
	});
});

describe("clamping goes down, never up", () => {
	it("keeps a level the model supports", () => {
		expect(clampThinkingLevelForModel(model(), "high")).toBe("high");
	});

	it("clamps a level above the model's maximum", () => {
		// `xhigh` and `max` are opt-in per model, so a reasoning model with no map
		// for them tops out at `high`.
		const clamped = clampThinkingLevelForModel(model(), "max");
		expect(clamped).toBe("high");
	});

	it("respects an explicit per-model ceiling", () => {
		// `xhigh` and `max` are opt-in per model, so a model without a map for them
		// does not support them.
		const capped = model({ thinkingLevelMap: { high: "high" } });
		expect(clampThinkingLevelForModel(capped, "xhigh")).toBe("high");
	});

	it("uses the model lowest level when nothing below the request is supported", () => {
		// Every level above minimal is disabled, so a request for `minimal` has
		// nothing below it. The result is the model lowest rather than nothing: a
		// model that can reason at all should reason, and silently dropping to "no
		// reasoning" would be a larger change than the user asked for.
		const onlyMinimal = model({
			thinkingLevelMap: { low: null, medium: null, high: null, xhigh: null, max: null },
		});
		expect(clampThinkingLevelForModel(onlyMinimal, "minimal")).toBe("minimal");
	});

	it("resolves to nothing for a model that cannot reason", () => {
		expect(clampThinkingLevelForModel(model({ reasoning: false }), "high")).toBeUndefined();
	});

	it("passes the request through when there is no model", () => {
		// Nothing to clamp against; the caller decides.
		expect(clampThinkingLevelForModel(undefined, "high")).toBe("high");
	});

	it("resolves to nothing for a requested level it does not recognise", () => {
		expect(clampThinkingLevelForModel(model(), "turbo" as ThinkingLevel)).toBeUndefined();
	});
});

describe("the one entry point a session uses", () => {
	it("produces the wire value from a configured one", () => {
		expect(resolveThinkingLevelForModel(model(), "high")).toBe("high");
		expect(resolveThinkingLevelForModel(model({ reasoning: false }), "high")).toBeUndefined();
	});

	it("sends nothing for auto, inherit and off alike", () => {
		expect(resolveThinkingLevelForModel(model(), AUTO_THINKING)).toBeUndefined();
		expect(resolveThinkingLevelForModel(model(), INHERIT_THINKING)).toBeUndefined();
		expect(resolveThinkingLevelForModel(model(), "off")).toBeUndefined();
		expect(resolveThinkingLevelForModel(model(), undefined)).toBeUndefined();
	});

	it("does not send a literal sentinel to a provider", () => {
		// The failure this exists to prevent: a request carrying reasoning:"auto".
		for (const configured of [AUTO_THINKING, INHERIT_THINKING, "off"] as const) {
			expect(resolveThinkingLevelForModel(model(), configured)).toBeUndefined();
		}
	});
});

describe("model capability", () => {
	it("reports nothing for a model that cannot reason", () => {
		expect(supportedThinkingLevels(model({ reasoning: false }))).toEqual(["off"]);
		expect(supportedThinkingLevels(undefined)).toEqual([]);
	});

	it("excludes a level the model maps to null", () => {
		// `null` is the explicit "this model does not do this level" marker.
		const withoutLow = model({ thinkingLevelMap: { low: null } });
		expect(supportedThinkingLevels(withoutLow)).not.toContain("low");
	});

	it("recognises a level for a settings row that must reject anything else", () => {
		expect(isThinkingLevel("high")).toBe(true);
		expect(isThinkingLevel("turbo")).toBe(false);
		expect(isThinkingLevel("auto")).toBe(false);
	});
});
