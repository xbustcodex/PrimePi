import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeResizeMode,
	isDestructive,
	isSettledResize,
	planScrollbackResize,
	SETTLE_MS,
	type ScrollbackResizeMode,
} from "../src/scrollback/resize.ts";

/**
 * Resize scrollback.
 *
 * The property that matters: a resize that changed nothing must not erase the
 * user's history. All three modes degrade to a repaint in that case, and losing
 * a transcript to a no-op resize is the worst outcome available here.
 */

describe("the three modes do what they say", () => {
	it("rebuild erases and replays", () => {
		const plan = planScrollbackResize({ mode: "rebuild", fromWidth: 200, toWidth: 80 });
		assert.equal(plan.eraseScrollback, true);
		assert.equal(plan.replay, true);
		// The only mode where every visible row is correct.
		assert.equal(isDestructive("rebuild"), true);
	});

	it("append replays below the history without erasing it", () => {
		const plan = planScrollbackResize({ mode: "append", fromWidth: 200, toWidth: 80 });
		assert.equal(plan.eraseScrollback, false);
		assert.equal(plan.replay, true);
		assert.equal(isDestructive("append"), false);
	});

	it("preserve repaints only, leaving the wrong wrapping in place", () => {
		const plan = planScrollbackResize({ mode: "preserve", fromWidth: 200, toWidth: 80 });
		assert.equal(plan.eraseScrollback, false);
		assert.equal(plan.replay, false);
		// Non-destructive and non-duplicating, and the history is still wrong.
		assert.equal(plan.repaintViewport, true);
		assert.equal(isDestructive("preserve"), false);
	});

	it("describes each mode in one line", () => {
		for (const mode of ["append", "rebuild", "preserve"] as ScrollbackResizeMode[]) {
			assert.ok(describeResizeMode(mode).length > 0);
		}
	});
});

describe("a resize that changed nothing", () => {
	it("repaints and does not erase, in every mode", () => {
		// Losing a transcript to a no-op resize is the worst outcome available here.
		for (const mode of ["append", "rebuild", "preserve"] as ScrollbackResizeMode[]) {
			const plan = planScrollbackResize({ mode, fromWidth: 100, toWidth: 100 });
			assert.equal(plan.eraseScrollback, false, mode);
			assert.equal(plan.replay, false, mode);
			assert.equal(plan.repaintViewport, true, mode);
		}
	});

	it("does not repair history no line was wrapped into", () => {
		// Every retained line already fits at the new width, so there is nothing
		// wrong to fix and erasing would be pure loss.
		const plan = planScrollbackResize({
			mode: "rebuild",
			fromWidth: 200,
			toWidth: 80,
			lines: [
				{ width: 80, wrapped: false },
				{ width: 80, wrapped: true },
			],
		});
		assert.equal(plan.eraseScrollback, false);
		assert.equal(plan.replay, false);
	});

	it("does repair a line wrapped at the old width", () => {
		const plan = planScrollbackResize({
			mode: "rebuild",
			fromWidth: 200,
			toWidth: 80,
			lines: [
				{ width: 80, wrapped: false },
				{ width: 200, wrapped: true },
			],
		});
		assert.equal(plan.eraseScrollback, true);
	});

	it("repaints when the retained history is unknown", () => {
		// Without line information there is nothing to check, so the mode decides -
		// and an unknown history is not a reason to skip the repair.
		const plan = planScrollbackResize({ mode: "rebuild", fromWidth: 200, toWidth: 80 });
		assert.equal(plan.eraseScrollback, true);
	});
});

describe("only a settled resize refreshes", () => {
	const base = { lastWidth: 80, width: 80, lastResizeAtMs: 1_000 };

	it("is unsettled while the width is still moving", () => {
		// A drag-resize produces a stream of widths milliseconds apart. Refreshing
		// on each erases history repeatedly and the user watches their conversation
		// disappear and reappear.
		assert.equal(isSettledResize({ ...base, width: 81, nowMs: 1_010 }), false);
		assert.equal(isSettledResize({ ...base, width: 82, nowMs: 1_010 }), false);
	});

	it("is unsettled before the hold elapses", () => {
		assert.equal(isSettledResize({ ...base, nowMs: 1_000 + SETTLE_MS - 1 }), false);
	});

	it("is settled once the width has held", () => {
		assert.equal(isSettledResize({ ...base, nowMs: 1_000 + SETTLE_MS }), true);
	});

	it("treats a first observation as settled, having no history to protect", () => {
		assert.equal(isSettledResize({ lastWidth: 80, width: 80, lastResizeAtMs: 0, nowMs: 5 }), true);
	});
});
