import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatTitle,
	isAsciiSpinner,
	MAX_TITLE_LENGTH,
	nextFrame,
	TITLE_SPINNERS,
	type TitleState,
} from "../src/status-line/title.ts";

/**
 * The terminal title.
 *
 * The properties are all about a very small space. **The state survives
 * truncation**, because it is the part that carries information and the part an
 * OS cuts. **The mark precedes the spinner**, so a terminal that freezes the
 * animation still shows a meaningful glyph. And **a spinner style the terminal
 * cannot render is a user choice**, not something to assume.
 */

const title = (overrides: Partial<Parameters<typeof formatTitle>[0]> = {}) =>
	formatTitle({ sessionName: "refactor", state: "idle", spinner: "none", ...overrides });

describe("the state mark", () => {
	it("differs for every state", () => {
		// "waiting" and "idle" are the pair most often confused, and the one a user
		// most needs to tell apart at a glance.
		const marks = new Set(
			(["idle", "working", "waiting", "done", "error"] as TitleState[]).map((s) => title({ state: s })[0]),
		);
		assert.equal(marks.size, 5);
	});

	it("can be turned off", () => {
		assert.equal(title({ state: "working", showState: false }), "refactor");
	});

	it("precedes the spinner", () => {
		// A frozen spinner frame is a glyph either way, so the state must not depend
		// on the animation running.
		const withSpinner = title({ state: "waiting", spinner: "braille", frame: 0 });
		assert.ok(withSpinner.startsWith("? "));
	});
});

describe("spinner styles", () => {
	it("renders nothing for none", () => {
		assert.equal(title({ spinner: "none" }), "· refactor");
	});

	it("renders a frame for each style", () => {
		for (const spinner of TITLE_SPINNERS) {
			if (spinner === "none") continue;
			const rendered = title({ spinner, frame: 0 });
			assert.ok(rendered.length > "· refactor".length, spinner);
		}
	});

	it("keeps a non-ASCII style opt-in", () => {
		// A terminal with a mismatched encoding renders these as replacement
		// characters, which is worse than no spinner.
		assert.equal(isAsciiSpinner("none"), true);
		assert.equal(isAsciiSpinner("braille"), false);
	});
});

describe("frame advance", () => {
	it("wraps at the style length", () => {
		const length = title({ spinner: "braille", frame: 0 }).length - title({ spinner: "none" }).length;
		for (let frame = 0; frame < 40; frame++) {
			assert.ok(nextFrame(frame, "braille") < 10, `frame ${frame}`);
		}
		assert.ok(length > 0);
	});

	it("stays at zero when there is no spinner", () => {
		assert.equal(nextFrame(5, "none"), 0);
	});

	it("handles a negative frame from a reset", () => {
		// An underflow would otherwise produce a negative index.
		const last = nextFrame(-1, "braille");
		assert.ok(last >= 0 && last < 10);
	});

	it("handles a non-finite frame", () => {
		const frame = nextFrame(Number.NaN, "braille");
		assert.ok(frame >= 0 && frame < 10);
	});
});

describe("truncation keeps the state", () => {
	const longName = "a".repeat(MAX_TITLE_LENGTH * 2);

	it("keeps the title within the limit", () => {
		assert.ok(title({ sessionName: longName }).length <= MAX_TITLE_LENGTH);
	});

	it("still shows the state after truncating", () => {
		// The mark is the part that survives every layout; cutting it would leave a
		// spinner with no meaning.
		assert.ok(title({ sessionName: longName, state: "error" }).startsWith("! "));
	});

	it("marks the truncation rather than silently cutting", () => {
		assert.ok(title({ sessionName: longName }).includes("…"));
	});

	it("leaves a short name alone", () => {
		assert.equal(title({ sessionName: "short" }), "· short");
	});
});

describe("an unnamed session", () => {
	it("still names the product", () => {
		// A bare glyph in a taskbar says nothing at all.
		assert.ok(title({ sessionName: undefined }).includes("pi"));
		assert.ok(title({ sessionName: "   " }).includes("pi"));
	});

	it("does not render a spinner with nothing to attach it to", () => {
		assert.equal(title({ sessionName: "", spinner: "none", showState: false }), "pi");
	});
});
