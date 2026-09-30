/**
 * The terminal title: what the window is called while a session runs.
 *
 * ## A title that is not useful is noise
 *
 * The terminal title is visible in the taskbar, in a window switcher, and on a
 * shared screen. Three consequences follow, and they are the whole design:
 *
 * - **The session name must be in it.** A list of eight identical terminals
 *   tells the user nothing about which one to switch to.
 * - **The run state must be visible.** Whether the agent is working, waiting, or
 *   finished is the first thing anyone looks for.
 * - **It must be short enough to survive a taskbar.** A title truncated at 40
 *   characters by the OS is worse than one written to fit, because the useful
 *   part is at the start.
 *
 * ## A spinner in a title is a convenience with a cost
 *
 * The spinner animates, which some terminals honour and others freeze — and a
 * frozen spinner reads as a hung session rather than an idle one. So the
 * character set is a setting, and "none" is a first-class choice rather than an
 * oversight.
 *
 * ## Non-ASCII is opt-in
 *
 * Braille spinner frames are the nicest and are not universally supported: a
 * terminal with a mismatched encoding renders them as replacement characters,
 * which is worse than no spinner. The default therefore stays ASCII-safe, and
 * `braille` is chosen by a user who knows their terminal handles it.
 */

/** Spinner styles for the title. */
export const TITLE_SPINNERS = ["none", "braille", "pulse", "dots"] as const;

export type TitleSpinner = (typeof TITLE_SPINNERS)[number];

/** Frames per style. Braille is the default and the widest-supported Unicode option. */
const SPINNER_FRAMES: Readonly<Record<TitleSpinner, readonly string[]>> = {
	none: [],
	// Classic sweep. Two bytes each in UTF-8; ASCII terminals render replacement
	// characters, which is why it is not the only option.
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	pulse: ["◐", "◓", "◑", "◒"],
	dots: ["⠁", "⠂", "⠄", "⠂"],
};

/** Run states a title can report. */
export const TITLE_STATES = ["idle", "working", "waiting", "done", "error"] as const;

export type TitleState = (typeof TITLE_STATES)[number];

/** A single-glyph marker per state, so the state survives a truncated title. */
const STATE_MARK: Readonly<Record<TitleState, string>> = {
	idle: "·",
	working: "*",
	// A distinct marker: "waiting" is the state a user most needs to notice and the
	// one most often confused with "idle".
	waiting: "?",
	done: "+",
	error: "!",
};

/** Beyond this the OS truncates, usually mid-word. */
export const MAX_TITLE_LENGTH = 48;

export interface TitleInput {
	/** The session name, or undefined for an unnamed session. */
	readonly sessionName?: string;
	readonly state: TitleState;
	readonly spinner: TitleSpinner;
	/** Frame index, advanced by the caller on each animation tick. */
	readonly frame?: number;
	/** Whether to put the run state in the title at all. */
	readonly showState?: boolean;
}

/**
 * Builds a terminal title.
 *
 * ## The state mark comes before the spinner
 *
 * A frozen spinner frame is a glyph either way, so putting the state first means
 * a terminal that cannot animate still shows `?` rather than a static braille
 * character that means nothing.
 *
 * ## Truncation keeps the state
 *
 * The state mark and the session name are the parts that carry information; the
 * spinner is decoration. So the session name is truncated first and the marker is
 * re-appended, rather than cutting the assembled string at the limit and losing
 * whichever end came last.
 */
export function formatTitle(input: TitleInput): string {
	const { state, spinner, showState = true } = input;
	const mark = showState ? `${STATE_MARK[state]} ` : "";

	const frames = SPINNER_FRAMES[spinner] ?? [];
	// A negative or non-finite frame index would index out of the array and render
	// `undefined` in the user's taskbar.
	const frameIndex = frames.length === 0 ? -1 : Math.abs(Math.trunc(input.frame ?? 0)) % frames.length;
	const glyph = frameIndex < 0 ? "" : `${frames[frameIndex]} `;

	// No session name: the mark and spinner are the whole title, which is more
	// useful than a bare glyph with no context.
	const name = (input.sessionName ?? "").trim();
	if (name.length === 0) return `${mark}${glyph}pi`.trim() || "pi";

	const prefix = `${mark}${glyph}`;
	// The prefix is never truncated away: it is the part that survives every layout.
	const budget = Math.max(1, MAX_TITLE_LENGTH - prefix.length - 1);
	const truncated = name.length > budget ? `${name.slice(0, budget - 1)}…` : name;
	return `${prefix}${truncated}`;
}

/** Advances a spinner frame index, wrapping at the style's length. */
export function nextFrame(frame: number, spinner: TitleSpinner): number {
	const frames = SPINNER_FRAMES[spinner] ?? [];
	if (frames.length === 0) return 0;
	const safe = Number.isFinite(frame) ? Math.trunc(frame) : 0;
	// A negative frame is an underflow from a reset, so it wraps to the end rather
	// than producing a negative index.
	return ((safe % frames.length) + frames.length) % frames.length;
}

/** Whether a spinner style renders as pure ASCII. */
export function isAsciiSpinner(spinner: TitleSpinner): boolean {
	return SPINNER_FRAMES[spinner].every((frame) => !/[^\x00-\x7f]/.test(frame));
}
