import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ComposerContents, DraftHistory, isEmptyComposer, recordDraft } from "../src/prompt/draft-history.ts";

/**
 * Composer draft history.
 *
 * The properties that matter: a composer holding an image is not empty, a
 * cleared draft is copied rather than referenced, and the cap drops the oldest
 * because the newest is the one a user reaching for arrow-up wants.
 */

function contents(overrides: Partial<ComposerContents> = {}): ComposerContents {
	return { text: "", images: [], imageLinks: [], texts: [], ...overrides };
}

describe("what counts as empty", () => {
	it("is empty when nothing is held", () => {
		assert.equal(isEmptyComposer(contents()), true);
	});

	it("treats whitespace-only text as empty", () => {
		// The reference checks `!getText().trim()`, so a composer holding only spaces
		// is empty. That is right: a stray space is not a draft worth arrow-up
		// restoring, and treating it as content would fill history with blanks.
		assert.equal(isEmptyComposer(contents({ text: "   " })), true);
		assert.equal(isEmptyComposer(contents({ text: " real " })), false);
	});

	it("is not empty for an image alone", () => {
		// Testing the text alone would let a clear silently discard an image the
		// user spent a step attaching.
		assert.equal(isEmptyComposer(contents({ images: ["/tmp/a.png"] })), false);
	});

	it("is not empty for a text attachment alone", () => {
		assert.equal(isEmptyComposer(contents({ texts: ["scratch note"] })), false);
	});

	it("is not empty for an image link alone", () => {
		assert.equal(isEmptyComposer(contents({ imageLinks: ["https://example.test/x.png"] })), false);
	});
});

describe("recording a draft", () => {
	it("records nothing from an empty composer", () => {
		// Otherwise arrow-up fills with blanks the user must page past to reach
		// anything real.
		assert.equal(recordDraft(contents(), 1), undefined);
	});

	it("copies the contents rather than referencing them", () => {
		const images = ["/tmp/a.png"];
		const snapshot = recordDraft(contents({ text: "draft", images }), 1);
		assert.ok(snapshot);
		// The composer mutates its own arrays in place; a history entry that changed
		// under the user would recall the wrong draft.
		images.push("/tmp/b.png");
		assert.equal(snapshot.images.length, 1);
	});
});

describe("the history", () => {
	it("records a cleared draft when recall is on", () => {
		const history = new DraftHistory();
		const snapshot = history.clear(contents({ text: "half-written thought" }), { recall: true, at: 1 });
		assert.equal(snapshot?.text, "half-written thought");
		assert.equal(history.size, 1);
	});

	it("records nothing when recall is off", () => {
		const history = new DraftHistory();
		assert.equal(history.clear(contents({ text: "draft" }), { recall: false, at: 1 }), undefined);
		assert.equal(history.size, 0);
	});

	it("records nothing for an empty clear, even with recall on", () => {
		// There was nothing to discard, so there is nothing to get back.
		const history = new DraftHistory();
		assert.equal(history.clear(contents(), { recall: true, at: 1 }), undefined);
		assert.equal(history.size, 0);
	});

	it("reads the setting at the moment of the clear, not at startup", () => {
		// Turning it off does not retroactively empty the history: a user who turns
		// it off has not asked for their past to be edited.
		const history = new DraftHistory();
		history.clear(contents({ text: "earlier" }), { recall: true, at: 1 });
		history.clear(contents({ text: "later" }), { recall: false, at: 2 });
		assert.equal(history.size, 1);
		assert.equal(history.latest()?.text, "earlier");
	});

	it("returns the most recent draft", () => {
		const history = new DraftHistory();
		history.clear(contents({ text: "first" }), { recall: true, at: 1 });
		history.clear(contents({ text: "second" }), { recall: true, at: 2 });
		assert.equal(history.latest()?.text, "second");
		assert.deepEqual(
			history.entries().map((entry) => entry.text),
			["first", "second"],
		);
	});

	it("takes the most recent entry when it is restored", () => {
		const history = new DraftHistory();
		history.clear(contents({ text: "first" }), { recall: true, at: 1 });
		history.clear(contents({ text: "second" }), { recall: true, at: 2 });
		assert.equal(history.take()?.text, "second");
		assert.equal(history.size, 1);
	});

	it("takes nothing from an empty history", () => {
		const history = new DraftHistory();
		assert.equal(history.take(), undefined);
		assert.equal(history.latest(), undefined);
	});
});

describe("the cap", () => {
	it("drops the oldest, keeping what arrow-up would reach for", () => {
		const history = new DraftHistory(3);
		for (let index = 0; index < 5; index++) {
			history.clear(contents({ text: `draft ${index}` }), { recall: true, at: index });
		}
		assert.deepEqual(
			history.entries().map((entry) => entry.text),
			["draft 2", "draft 3", "draft 4"],
		);
	});

	it("has a floor, so a limit of zero is not a feature that does nothing", () => {
		const history = new DraftHistory(0);
		history.clear(contents({ text: "kept" }), { recall: true, at: 1 });
		assert.equal(history.size, 1);
	});
});
