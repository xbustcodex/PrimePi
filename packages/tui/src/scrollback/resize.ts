/**
 * Resize scrollback: what a settled terminal resize does to retained history.
 *
 * ## The problem
 *
 * A terminal's scrollback holds transcript rows wrapped at whatever width was
 * current when they were written. A resize leaves that history wrapped at the
 * old width, so a 200-column line re-wrapped at 80 columns is unreadable — and
 * the user cannot scroll back to read it, because it is already wrong.
 *
 * There is no universally correct answer, which is why this is a setting with
 * three real strategies rather than a boolean.
 *
 * ## The three
 *
 * **append** replays the transcript at the new width *below* the retained
 * history. The old rows stay exactly as they were and the new ones are correct.
 * The cost is duplication: the same conversation appears twice, and a user
 * scrolling back sees the narrow version first.
 *
 * **rebuild** erases all scrollback and replays one transcript at the current
 * width. Everything is correct and there is exactly one copy. The cost is
 * destructive: the old history is gone, and a user who wanted to read a line
 * from before the resize can no longer.
 *
 * **preserve** repaints only the viewport and leaves history wrapped at its old
 * width. Nothing is destroyed and nothing is duplicated, and the history is
 * still wrong at the new width.
 *
 * ## Why `rebuild` is the default
 *
 * It is the only mode where *everything visible is correct*. `append` leaves the
 * user scrolling through two versions of the same conversation and `preserve`
 * leaves them scrolling through text that no longer fits. Both defer the problem
 * to the scrollback, where the user is reading rather than looking.
 *
 * ## Only a *settled* resize refreshes
 *
 * A resize while the session is actively rendering produces a transient width,
 * and rebuilding scrollback on every intermediate size would erase history
 * several times in a second. A resize only refreshes once the terminal has been
 * the same width for a moment.
 */

/** How a resize refreshes retained history. */
export type ScrollbackResizeMode = "append" | "rebuild" | "preserve";

export const SCROLLBACK_RESIZE_MODES: readonly ScrollbackResizeMode[] = ["append", "rebuild", "preserve"];

/** One line's metadata, enough to decide whether it needs re-wrapping. */
export interface ScrollbackLine {
	/** The width the line was written at. */
	readonly width: number;
	/** Whether the line was hard-wrapped at that width. */
	readonly wrapped: boolean;
}

/** What a resize should do. */
export interface ResizePlan {
	readonly mode: ScrollbackResizeMode;
	/** Whether to erase the terminal's scrollback. */
	readonly eraseScrollback: boolean;
	/** Whether to replay the transcript at the new width. */
	readonly replay: boolean;
	/** Whether to repaint the viewport. */
	readonly repaintViewport: boolean;
	readonly reason: string;
}

/** A resize is "settled" once the width has held for this long. */
export const SETTLE_MS = 120;

/**
 * Whether a resize is settled, and therefore eligible to refresh history.
 *
 * A drag-resize produces a stream of widths milliseconds apart. Refreshing
 * scrollback on each one erases history repeatedly, and the user watches their
 * conversation disappear and reappear.
 */
export function isSettledResize(input: {
	readonly lastWidth: number;
	readonly width: number;
	readonly nowMs: number;
	readonly lastResizeAtMs: number;
}): boolean {
	if (input.width !== input.lastWidth) return false;
	// A first observation has no history to protect.
	if (input.lastResizeAtMs === 0) return true;
	return input.nowMs - input.lastResizeAtMs >= SETTLE_MS;
}

/**
 * Decides what a settled resize does.
 *
 * The history check is an optimisation, not a shortcut: if every retained line
 * was written at the new width, there is nothing wrong to fix and all three
 * modes degrade to a repaint. That avoids erasing scrollback for a resize that
 * changed nothing.
 */
export function planScrollbackResize(input: {
	readonly mode: ScrollbackResizeMode;
	readonly fromWidth: number;
	readonly toWidth: number;
	/** The retained lines, when the terminal can report them. */
	readonly lines?: readonly ScrollbackLine[];
}): ResizePlan {
	const changed = input.toWidth !== input.fromWidth;
	// Nothing about the rendering changes, so nothing about history needs fixing.
	if (!changed) {
		return {
			mode: input.mode,
			eraseScrollback: false,
			replay: false,
			repaintViewport: true,
			reason: "the width did not change",
		};
	}

	// Every retained line already fits at the new width, so the history is not
	// wrong and none of the three modes has anything to repair.
	const history = input.lines;
	if (history && history.length > 0 && history.every((line) => !line.wrapped || line.width === input.toWidth)) {
		return {
			mode: input.mode,
			eraseScrollback: false,
			replay: false,
			repaintViewport: true,
			reason: "no retained line was wrapped at the old width",
		};
	}

	switch (input.mode) {
		case "rebuild":
			return {
				mode: "rebuild",
				eraseScrollback: true,
				replay: true,
				repaintViewport: true,
				// The only mode where everything visible is correct.
				reason: "erase and replay so no retained row is wrapped at the wrong width",
			};
		case "append":
			return {
				mode: "append",
				eraseScrollback: false,
				replay: true,
				repaintViewport: true,
				// The old rows stay as they were, so the user scrolls through two
				// versions of the same conversation.
				reason: "replay below the retained history, leaving the old rows untouched",
			};
		case "preserve":
			return {
				mode: "preserve",
				eraseScrollback: false,
				replay: false,
				repaintViewport: true,
				// Non-destructive and non-duplicating, and the history is still wrong.
				reason: "repaint the viewport only; retained history keeps its old wrapping",
			};
	}
}

/** Whether a mode destroys anything the user cannot get back. */
export function isDestructive(mode: ScrollbackResizeMode): boolean {
	// `rebuild` erases; the other two only add or repaint.
	return mode === "rebuild";
}

/** One line of user-facing explanation, for a settings hint. */
export function describeResizeMode(mode: ScrollbackResizeMode): string {
	switch (mode) {
		case "append":
			return "Replay the transcript at the new width below retained history";
		case "rebuild":
			return "Erase all terminal scrollback, then replay one current-width transcript";
		case "preserve":
			return "Repaint only the viewport and keep history wrapped at its old width";
	}
}
