import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_THINKING_PRESENTATION,
	describePresentation,
	ELIDED_CODE_MARKER,
	requestEffect,
	resolveThinkingDisplay,
	type ThinkingPresentationSettings,
	toProseOnly,
} from "../src/chat/thinking-presentation.ts";

/**
 * Reasoning presentation.
 *
 * The property that matters: **hiding changes the screen, omitting changes the
 * request.** Conflating them is how a user sets "hide" and wonders why the bill
 * is unchanged.
 */

const settings = (overrides: Partial<ThinkingPresentationSettings> = {}): ThinkingPresentationSettings => ({
	...DEFAULT_THINKING_PRESENTATION,
	...overrides,
});

const THINKING = [
	"I need to check the parser.",
	"",
	"```ts",
	"const x = parse(input);",
	"```",
	"",
	"It splits on the first colon.",
].join("\n");

describe("what counts as a code block", () => {
	it("elides a fenced block and keeps the prose around it", () => {
		const { text, elided } = toProseOnly(THINKING);
		assert.ok(!text.includes("const x = parse"));
		// The reasoning around the block usually says what the code was for.
		assert.ok(text.includes("I need to check the parser."));
		assert.ok(text.includes("It splits on the first colon."));
		assert.equal(elided.length, 1);
	});

	it("leaves a marker rather than a silent gap", () => {
		// A gap with no marker reads as a rendering fault rather than a decision.
		const { text } = toProseOnly(THINKING);
		assert.ok(text.includes(ELIDED_CODE_MARKER));
	});

	it("keeps the language, which says what was elided without the body", () => {
		const { text } = toProseOnly(THINKING);
		assert.ok(text.includes("ts"));
	});

	it("handles tilde fences and XML blocks too", () => {
		const tilde = toProseOnly("before\n~~~\nbody\n~~~\nafter");
		assert.ok(!tilde.text.includes("body"));
		assert.ok(tilde.text.includes("before"));
		const xml = toProseOnly("before\n<diff>\n+added\n</diff>\nafter");
		assert.ok(!xml.text.includes("+added"));
		assert.ok(xml.text.includes("before"));
	});

	it("elides every block, not every other one", () => {
		// A shared global regex carries lastIndex between calls, which skips blocks
		// on a second rendering of the same text.
		const { elided } = toProseOnly("```\na\n```\ntext\n```\nb\n```\n```\nc\n```");
		assert.equal(elided.length, 3);
	});

	it("leaves prose with no blocks alone", () => {
		const { text, elided } = toProseOnly("just prose");
		assert.equal(text, "just prose");
		assert.equal(elided.length, 0);
	});
});

describe("what is rendered", () => {
	it("renders prose by default", () => {
		const display = resolveThinkingDisplay(THINKING, settings());
		assert.equal(display.kind, "prose");
	});

	it("renders raw when prose-only is off", () => {
		const display = resolveThinkingDisplay(THINKING, settings({ proseOnlyThinking: false }));
		assert.equal(display.kind, "raw");
		if (display.kind !== "raw") return;
		assert.ok(display.text.includes("const x = parse"));
	});

	it("hides when asked to", () => {
		assert.equal(resolveThinkingDisplay(THINKING, settings({ hideThinkingBlock: true })).kind, "hidden");
	});

	it("hides for a scratchpad even when hiding is off", () => {
		// A scratchpad is never shown whatever else is set.
		assert.equal(resolveThinkingDisplay(THINKING, settings({ externalThinking: true })).kind, "hidden");
	});
});

describe("hiding changes the screen, omitting changes the request", () => {
	it("hiding does not change what is asked for", () => {
		const effect = requestEffect(settings({ hideThinkingBlock: true }));
		// The provider still produces it and it still costs tokens.
		assert.equal(effect.requestReasoning, true);
		assert.equal(effect.omitReasoning, false);
	});

	it("omitting asks the provider to produce none", () => {
		const effect = requestEffect(settings({ omitThinking: true }));
		// The only setting that saves tokens.
		assert.equal(effect.omitReasoning, true);
		assert.equal(effect.requestReasoning, true);
	});

	it("a scratchpad disables reasoning rather than merely hiding it", () => {
		// A scratchpad the user cannot see but the provider still emits is neither.
		const effect = requestEffect(settings({ externalThinking: true }));
		assert.equal(effect.disableReasoning, true);
		assert.equal(effect.requestReasoning, false);
	});

	it("prose-only does not change the request at all", () => {
		const effect = requestEffect(settings({ proseOnlyThinking: true }));
		assert.equal(effect.requestReasoning, true);
		assert.equal(effect.omitReasoning, false);
		assert.equal(effect.disableReasoning, false);
	});
});

describe("each setting says what it actually changes", () => {
	it("says hiding costs tokens still", () => {
		assert.ok(
			describePresentation("hideThinkingBlock", settings({ hideThinkingBlock: true })).includes("costs tokens"),
		);
	});

	it("says omitting saves them", () => {
		assert.ok(describePresentation("omitThinking", settings({ omitThinking: true })).includes("omit"));
	});

	it("says a scratchpad disables reasoning", () => {
		assert.ok(describePresentation("externalThinking", settings({ externalThinking: true })).includes("disabled"));
	});

	it("says prose-only keeps the surrounding reasoning", () => {
		assert.ok(describePresentation("proseOnlyThinking", settings()).includes("surrounding reasoning"));
	});
});
