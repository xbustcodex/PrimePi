/**
 * Composer draft history: what a clear throws away, and what it can get back.
 *
 * ## The rule
 *
 * A clear that **discards content** puts that content in recall history. A
 * clear of an **already empty** editor does not, because there was nothing to
 * discard and putting an empty entry in history would fill the up-arrow with
 * blanks the user has to arrow past to reach anything real.
 *
 * ## What counts as content
 *
 * Everything the composer holds, not just the text: pending images, image
 * links, and text attachments. A composer holding an image and no text is *not*
 * empty, and clearing it must not lose the image.
 *
 * ## Why "affects future clears"
 *
 * The setting is read at the moment of the clear, not at startup. Turning it off
 * does not retroactively empty the history of drafts already recorded — the
 * drafts a user cleared while it was on are still recallable. That is the honest
 * behaviour: the setting governs what happens next, and a user who turns it off
 * has not asked for their past to be edited.
 *
 * ## Bounded by session, not by memory
 *
 * History is a session-scoped convenience, not a store. It is capped so a long
 * session cannot grow it without bound, and the cap drops the *oldest* entry,
 * because the most recently discarded draft is the one a user reaching for
 * arrow-up almost certainly wants.
 */

/** One discarded draft, with everything the composer held at the time. */
export interface DraftSnapshot {
	readonly text: string;
	readonly images: readonly string[];
	readonly imageLinks: readonly string[];
	readonly texts: readonly string[];
	/** When it was recorded, for display and for eviction order. */
	readonly at: number;
}

/** Everything the composer holds, which is more than its text. */
export interface ComposerContents {
	readonly text: string;
	readonly images: readonly string[];
	readonly imageLinks: readonly string[];
	readonly texts: readonly string[];
}

/** Whether the composer holds anything a user would miss. */
export function isEmptyComposer(contents: ComposerContents): boolean {
	// A composer holding an image and no text is not empty. Testing the text alone
	// would let a clear silently discard an image the user spent a step attaching.
	return (
		contents.text.trim().length === 0 &&
		contents.images.length === 0 &&
		contents.imageLinks.length === 0 &&
		contents.texts.length === 0
	);
}

/**
 * Records a draft for recall.
 *
 * Returns the snapshot that was stored, or `undefined` when the composer was
 * empty and nothing was worth remembering.
 */
export function recordDraft(contents: ComposerContents, at: number): DraftSnapshot | undefined {
	if (isEmptyComposer(contents)) return undefined;
	// Copied, not referenced: the composer mutates its own arrays in place, and a
	// history entry that changed under the user would recall the wrong draft.
	return {
		text: contents.text,
		images: [...contents.images],
		imageLinks: [...contents.imageLinks],
		texts: [...contents.texts],
		at,
	};
}

/** A bounded, session-scoped draft history. */
export class DraftHistory {
	readonly #entries: DraftSnapshot[] = [];
	readonly #limit: number;

	constructor(limit = 50) {
		// A cap with a floor: a limit of one or zero would make the history a
		// feature that silently does nothing.
		this.#limit = Math.max(1, Math.trunc(limit));
	}

	get size(): number {
		return this.#entries.length;
	}

	/**
	 * Records a cleared draft, if there was one.
	 *
	 * The `recall` flag is read here, at the moment of the clear, so a setting
	 * change governs future clears rather than rewriting the past.
	 */
	clear(contents: ComposerContents, options: { recall: boolean; at: number }): DraftSnapshot | undefined {
		if (!options.recall) return undefined;
		const snapshot = recordDraft(contents, options.at);
		if (!snapshot) return undefined;
		this.#entries.push(snapshot);
		// Oldest first, because the most recently discarded draft is the one a user
		// reaching for arrow-up almost certainly wants.
		while (this.#entries.length > this.#limit) this.#entries.shift();
		return snapshot;
	}

	/** The most recent draft, which arrow-up restores. */
	latest(): DraftSnapshot | undefined {
		return this.#entries.at(-1);
	}

	/** Every entry, oldest first, for a status line or a test. */
	entries(): readonly DraftSnapshot[] {
		return this.#entries;
	}

	/** Drops the most recent entry, having restored it. */
	take(): DraftSnapshot | undefined {
		return this.#entries.pop();
	}
}
