/**
 * The onboarding wizard frame: owns scene sequencing, the body-height budget, and completion.
 *
 * Ported from the reference's `setup/wizard-overlay.ts` with the phase machine reduced to what
 * Prime Pi actually needs. The reference runs splash -> scenes -> outro as distinct phases
 * here; Prime Pi's splash is already on the launch path and gated separately, so this frame is
 * scenes-only and ends when the last scene finishes.
 *
 * Two behaviours worth stating, because they are the ones that decide whether onboarding feels
 * trustworthy:
 *
 * - **The budget is advisory to the scene, authoritative for the frame.** A scene is told how
 *   many body rows it actually gets. If it overruns, the frame clips - it does not scroll, so
 *   the selected row can never move out from under the cursor as the list changes.
 * - **Completion is recorded once, after the last scene, never per scene.** A scene that
 *   throws or is interrupted leaves `setup.version` untouched, so the next launch resumes.
 */

import { getKeybindings } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import { keyHint, rawKeyHint } from "../interactive/components/keybinding-hints.ts";
import { theme } from "../interactive/theme/theme.ts";
import {
	CURRENT_SETUP_VERSION,
	type SetupHost,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
} from "./setup-scenes.ts";

/** Rows the frame itself occupies: top border, gap, title, gap, hint row, bottom border. */
const FRAME_CHROME_ROWS = 6;
/** Below this total height the frame drops its chrome and renders only the scene body. */
const COMPACT_FRAME_ROWS = 24;
/** Total rows needed before the frame will render at all; narrower terminals get a notice. */
const MINIMUM_TOTAL_ROWS = 12;

export interface SetupWizardOptions {
	readonly ctx: SetupHost;
	readonly scenes: readonly SetupScene[];
	readonly terminalRows: number;
	readonly terminalColumns: number;
	/**
	 * Called once the final scene finishes, so the caller can continue to the main interface.
	 *
	 * Completion is recorded by the frame via `ctx.markComplete`, *before* this is called, so a
	 * caller cannot forget it and leave the user to be onboarded again on every launch. The
	 * host owns the write because the host owns the settings authority.
	 */
	onComplete(): void;
	/** Called when the user exits setup. Completion is *not* recorded. */
	onCancel(): void;
	/**
	 * Ask the host to repaint.
	 *
	 * Required rather than optional: a scene calls it on every selection change, and wiring it
	 * to a no-op means arrowing through a list appears to do nothing.
	 */
	requestRender(): void;
}

/**
 * Sequential onboarding frame.
 *
 * Not a `Container`: scenes render their own body rows so the frame can reserve exactly the
 * space it needs and clip predictably, which a child-component layout cannot express.
 */
export class SetupWizard {
	private readonly options: SetupWizardOptions;
	private index = 0;
	private controller: SetupSceneController | undefined;
	private error: string | undefined;
	private done = false;

	constructor(options: SetupWizardOptions) {
		this.options = options;
		this.mountCurrent();
	}

	private get scene(): SetupScene | undefined {
		return this.options.scenes[this.index];
	}

	/**
	 * The scene currently mounted, and its zero-based position.
	 *
	 * Read-only. Exposed because "which scene am I on" is the one thing a caller legitimately
	 * needs to know - the progress hint and the launch path both depend on it - and it is far
	 * better to read it than to infer it from rendered text.
	 */
	get position(): { readonly index: number; readonly scene: SetupScene | undefined; readonly total: number } {
		return { index: this.index, scene: this.scene, total: this.options.scenes.length };
	}

	private mountCurrent(): void {
		const scene = this.scene;
		if (!scene) {
			this.complete();
			return;
		}
		const host: SetupSceneHost = {
			ctx: this.options.ctx,
			requestRender: () => this.options.requestRender?.(),
			finish: () => this.advance(),
		};
		this.error = undefined;
		this.controller = scene.mount(host);
	}

	private advance(): void {
		this.controller?.dispose?.();
		this.controller = undefined;
		this.index += 1;
		if (this.index >= this.options.scenes.length) {
			this.complete();
			return;
		}
		this.mountCurrent();
	}

	private complete(): void {
		if (this.done) return;
		this.done = true;
		// Recorded here, at the single point where the wizard finishes, rather than by the
		// caller: this is what suppresses the wizard on the next launch, and an interruption
		// must leave it untouched so the user resumes instead of restarting.
		const written = this.options.ctx.markComplete(CURRENT_SETUP_VERSION);
		this.options.onComplete();
		// Surfaced rather than swallowed: if the write fails, the user would be re-onboarded
		// with no explanation, which is worse than a visible error.
		void written?.catch((error: unknown) => {
			this.options.ctx.showError(
				`Setup could not be saved: ${error instanceof Error ? error.message : String(error)}. ` +
					`Setup will run again next launch.`,
			);
		});
	}

	/**
	 * Exit setup without recording completion.
	 *
	 * `setup.version` stays where it was, so the next launch picks up at the same scene. This
	 * is the whole of interrupted-wizard recovery: there is no partial-progress state to get
	 * out of step, because progress is only ever recorded at the end.
	 */
	exit(): void {
		if (this.done) return;
		this.done = true;
		this.controller?.dispose?.();
		this.controller = undefined;
		this.options.onCancel();
	}

	handleInput(keyData: string): void {
		if (this.done) return;
		const kb = getKeybindings();
		// Ctrl+C leaves setup without recording completion, matching the reference's "exit
		// setup" affordance. Matched on the raw control byte: `ctrl+c` is not a registered
		// action name (it is bound as `tui.input.copy`, which is wrong to reuse here), and the
		// reference matches the same byte directly.
		if (keyData === "\x03") {
			this.exit();
			return;
		}
		if (this.options.terminalRows < MINIMUM_TOTAL_ROWS) return;
		this.controller?.handleInput(keyData);
	}

	/**
	 * Render one frame.
	 *
	 * Returns plain strings rather than a component tree so the caller can present the wizard
	 * through whichever host it already owns, and so the budget arithmetic is testable without
	 * a terminal.
	 */
	render(): readonly string[] {
		const { terminalColumns, terminalRows } = this.options;
		if (terminalRows < MINIMUM_TOTAL_ROWS) {
			return [
				theme.fg("warning", `Resize to at least ${MINIMUM_TOTAL_ROWS} rows to run setup (${terminalRows} now).`),
			];
		}

		const scene = this.scene;
		if (!scene) return [];

		const compact = terminalRows < COMPACT_FRAME_ROWS;
		// border, gap, title, gap, hint, border
		const chromeRows = compact ? 0 : FRAME_CHROME_ROWS;
		// Always leave at least a few body rows, so a tall header cannot starve the scene.
		const bodyRows = Math.max(2, terminalRows - chromeRows);
		const width = Math.max(20, terminalColumns - 4);
		const body = this.controller ? this.controller.render(width, bodyRows) : [];

		const out: string[] = [];
		if (!compact) {
			out.push(theme.fg("border", "─".repeat(Math.max(1, terminalColumns - 1))));
			out.push("");
		}
		out.push(theme.fg("accent", theme.bold(scene.title)));
		if (!compact) out.push("");
		out.push(...body.slice(0, bodyRows));
		if (this.error) {
			out.push("");
			out.push(theme.fg("error", this.error));
		}
		if (!compact) {
			out.push("");
			out.push(
				theme.fg(
					"muted",
					`${this.index + 1} of ${this.options.scenes.length}  ·  ` +
						rawKeyHint("↑↓", "navigate") +
						"  " +
						keyHint("tui.select.confirm", "continue") +
						"  " +
						keyHint("tui.select.cancel", "exit setup") +
						`  ·  ${APP_NAME}`,
				),
			);
			out.push(theme.fg("border", "─".repeat(Math.max(1, terminalColumns - 1))));
		}
		return out;
	}

	/** Surface a non-fatal problem without tearing down the scene. */
	showError(message: string): void {
		this.error = message;
	}
}

/**
 * A single-choice scene over a fixed option list.
 *
 * Four of the five onboarding scenes are this shape - pick one of N, see it applied, move on -
 * so they share one implementation rather than four copies of index arithmetic. Scenes that
 * need real interaction (provider sign-in, model search) implement the contract directly.
 */
export interface ChoiceOption<T> {
	readonly value: T;
	readonly label: string;
	/** Optional second line, rendered dimmed under the label. */
	readonly detail?: string;
	/** Longest label rendered without wrapping; the window is sized from this. */
	readonly preview?: readonly string[];
}

export class ChoiceScene<T> implements SetupSceneController {
	private index: number;
	private readonly options: ChoiceOption<T>[];
	private readonly host: SetupSceneHost;
	/** Applied on every index change, so the choice is previewed while browsing. */
	private readonly onPreview: (value: T) => void;
	/** Applied once, on confirm. */
	private readonly onCommit: (value: T) => Promise<void> | void;
	private busy: string | undefined;

	constructor(options: {
		host: SetupSceneHost;
		options: readonly ChoiceOption<T>[];
		initial?: T;
		onPreview(value: T): void;
		onCommit(value: T): Promise<void> | void;
	}) {
		this.host = options.host;
		this.options = [...options.options];
		this.onPreview = options.onPreview;
		this.onCommit = options.onCommit;
		const initial = options.initial;
		const found = initial === undefined ? -1 : this.options.findIndex((option) => option.value === initial);
		this.index = found >= 0 ? found : 0;
	}

	render(width: number, maxLines: number): readonly string[] {
		const out: string[] = [];
		if (this.busy !== undefined) {
			out.push(theme.fg("muted", this.busy));
			return out;
		}
		// Reserve a row for the detail line of whichever option is selected, when any has one.
		const detailRows = this.options[this.index]?.detail ? 2 : 1;
		const rowsAvailable = Math.max(1, maxLines);
		// Keep the selection inside the window as the user arrows past the edges.
		const windowSize = Math.max(1, rowsAvailable - detailRows);
		const start = Math.max(0, Math.min(this.index - Math.floor(windowSize / 2), this.options.length - windowSize));
		const end = Math.min(this.options.length, Math.max(start + windowSize, start + 1));
		for (let i = Math.max(0, start); i < end; i++) {
			const option = this.options[i];
			const selected = i === this.index;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const label = selected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
			out.push(`${prefix}${label}`.slice(0, width));
			if (selected && option.detail) {
				out.push(theme.fg("muted", `    ${option.detail}`).slice(0, width));
			}
		}
		return out;
	}

	handleInput(keyData: string): void {
		if (this.busy !== undefined) return;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.move(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.move(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			void this.confirm();
		}
	}

	private move(delta: number): void {
		if (this.options.length === 0) return;
		const next = Math.min(this.options.length - 1, Math.max(0, this.index + delta));
		if (next === this.index) return;
		this.index = next;
		this.onPreview(this.options[next].value);
		this.host.requestRender();
	}

	private async confirm(): Promise<void> {
		const option = this.options[this.index];
		if (!option) return;
		this.busy = "Saving…";
		this.host.requestRender();
		try {
			await this.onCommit(option.value);
			this.host.finish("done");
		} catch (error) {
			this.busy = undefined;
			this.host.ctx.showError(error instanceof Error ? error.message : String(error));
			this.host.requestRender();
		}
	}
}

/** A scene that renders fixed explanatory content and advances on confirm. */
export class NoticeScene implements SetupSceneController {
	private readonly host: SetupSceneHost;
	private readonly lines: readonly string[];

	constructor(host: SetupSceneHost, lines: readonly string[]) {
		this.host = host;
		this.lines = lines;
	}

	render(_width: number, maxLines: number): readonly string[] {
		return this.lines.slice(0, maxLines);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.host.finish("done");
		}
	}
}
