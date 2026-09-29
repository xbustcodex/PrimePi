/**
 * Native terminal progress: the taskbar spinner.
 *
 * ## What it emits
 *
 * An OSC 9;4 sequence, which terminals from a small set render as a taskbar
 * progress indicator. A terminal that does not understand it ignores the
 * sequence, so the capability degrades to nothing rather than to garbage.
 *
 * ## The rule that matters
 *
 * **Progress is only ever cleared by whoever set it.**
 *
 * A session that never turned progress on must not clear it. A clear is an
 * instruction to the terminal, and one session clearing a spinner another
 * started leaves a taskbar showing nothing while work is genuinely running - a
 * user watching a wrong indicator rather than no indicator.
 *
 * So the active flag is the authority. `set` checks it and refuses if progress is
 * already owned; `clear` is a no-op unless this owner set it. The check is
 * `active` rather than the setting, because a user can toggle the setting
 * mid-run and a setting-driven clear would fire for a progress bar this session
 * never started.
 *
 * ## Why it is off by default
 *
 * The sequence writes to the terminal outside the render loop, so a session that
 * emits it on paths a caller does not expect will clear or set a spinner during
 * an unrelated turn. Off until asked is the right default for something that
 * reaches outside the normal frame.
 */

import { stdout } from "node:process";

/** Begins an indeterminate progress indication. */
export const PROGRESS_BEGIN = "]9;4;1";

/** Ends an indeterminate progress indication. */
export const PROGRESS_END = "]9;4;0";

/**
 * Whether a terminal is expected to render the sequence.
 *
 * Capability is a guess by terminal identity, never a probe that writes to the
 * user's screen: a probe is itself an escape sequence, and one that reaches a
 * terminal which does not support it leaves a stray character in the transcript.
 */
export function terminalSupportsProgress(terminalProgram: string | undefined): boolean {
	if (!terminalProgram) return false;
	const known = ["WezTerm", "kitty", "ghostty", "foot", "rio", "contour", "WarpTerminal", "vscode"];
	return known.some((name) => terminalProgram.includes(name));
}

/**
 * Owns the terminal's progress indicator for one session.
 *
 * One instance per session, and the ownership flag is what makes clearing safe.
 */
export class TerminalProgress {
	readonly #enabled: boolean;
	readonly #write: (sequence: string) => void;
	#active = false;

	constructor(options: { enabled: boolean; write?: (sequence: string) => void }) {
		this.#enabled = options.enabled;
		// Injected so the policy is testable without a terminal, and so a session can
		// route the sequence through its own output path.
		this.#write =
			options.write ??
			((sequence) => {
				stdout.write(sequence);
			});
	}

	/** Whether this owner currently has the indicator set. */
	get active(): boolean {
		return this.#active;
	}

	/**
	 * Sets the indicator, if enabled and not already owned.
	 *
	 * A second `set` is a no-op rather than a second write: some terminals
	 * restart their animation on a repeated begin sequence, which reads as a
	 * flicker.
	 */
	set(): boolean {
		if (!this.#enabled) return false;
		if (this.#active) return false;
		this.#write(PROGRESS_BEGIN);
		this.#active = true;
		return true;
	}

	/**
	 * Clears the indicator, but only if this owner set it.
	 *
	 * A session that never turned progress on must not clear another session's.
	 */
	clear(): boolean {
		if (!this.#active) return false;
		this.#write(PROGRESS_END);
		this.#active = false;
		return true;
	}

	/**
	 * Clears unconditionally, for a shutdown path.
	 *
	 * The one case where clearing another owner's indicator is correct: the
	 * process is ending and a spinner left behind would outlive it.
	 */
	clearOnExit(): void {
		if (!this.#active) return;
		this.#write(PROGRESS_END);
		this.#active = false;
	}
}

/** One line for a settings hint, naming what the sequence does and is not. */
export function describeProgress(supported: boolean): string {
	return supported
		? "Emits OSC 9;4 so the terminal shows a taskbar spinner while the agent is working."
		: "This terminal is not known to render OSC 9;4, so the sequence would be ignored.";
}
