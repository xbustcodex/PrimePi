/**
 * Symbol presets: one place that decides which glyphs the UI draws.
 *
 * Prime Pi's UI draws Unicode box-drawing characters, box-drawing-adjacent shapes and arrow
 * glyphs unconditionally. That is fine on a modern terminal and wrong in two places a user
 * actually hits: a legacy Windows console that renders them as empty boxes, and a font without
 * coverage for the more exotic code points.
 *
 * This module exists so `symbolPreset` is not a dead setting. A preference nothing reads is
 * worse than no preference: the settings panel offers it, the value persists, and nothing
 * changes - which is exactly the failure `theme.dark`/`theme.light` had before it was fixed.
 *
 * A preset is chosen by **capability, not by guesswork about fonts**. We cannot know what
 * glyphs a font has, but we can know whether the terminal advertises the Unicode extension and
 * whether it is on a platform whose default codepage cannot carry these code points. So:
 *
 * - `ascii`  - always safe; plain ASCII only.
 * - `default`- Unicode box drawing and arrows. The safe default on a UTF-8 terminal.
 * - `nerd`   - additionally allows Powerline/nerd-font private-use shapes.
 * - `minimal`- a reduced set for terminals with partial box-drawing coverage.
 */

/** The persisted vocabulary. Declared here, and read from here, so it cannot drift. */
export type SymbolPreset = "default" | "minimal" | "ascii" | "nerd";

export const SYMBOL_PRESETS: readonly SymbolPreset[] = ["default", "minimal", "ascii", "nerd"];

export function isSymbolPreset(value: string): value is SymbolPreset {
	return (SYMBOL_PRESETS as readonly string[]).includes(value);
}

/** Everything the UI can draw, named. One entry per glyph the renderer may need. */
export interface SymbolSet {
	readonly horizontal: string;
	readonly vertical: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontalHeavy: string;
	readonly arrowRight: string;
	readonly arrowLeft: string;
	readonly arrowUp: string;
	readonly arrowDown: string;
	readonly selected: string;
	readonly unselected: string;
	readonly success: string;
	readonly failure: string;
	readonly pending: string;
	/** Private-use glyphs. Empty in every preset but `nerd`. */
	readonly powerlineBranch: string;
	readonly powerlineEdge: string;
}

const UNICODE: SymbolSet = {
	horizontal: "─",
	vertical: "│",
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontalHeavy: "━",
	arrowRight: "→",
	arrowLeft: "←",
	arrowUp: "↑",
	arrowDown: "↓",
	selected: "●",
	unselected: "○",
	success: "✓",
	failure: "✗",
	pending: "◦",
	powerlineBranch: "",
	powerlineEdge: "",
};

const MINIMAL: SymbolSet = {
	// Box-drawing without the rounded corners, which are the code points most often missing
	// from a partial-coverage terminal font.
	horizontal: "─",
	vertical: "│",
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontalHeavy: "─",
	arrowRight: "→",
	arrowLeft: "←",
	arrowUp: "↑",
	arrowDown: "↓",
	selected: "*",
	unselected: "o",
	success: "+",
	failure: "x",
	pending: ".",
	powerlineBranch: "",
	powerlineEdge: "",
};

const ASCII_SET: SymbolSet = {
	horizontal: "-",
	vertical: "|",
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontalHeavy: "=",
	arrowRight: ">",
	arrowLeft: "<",
	arrowUp: "^",
	arrowDown: "v",
	selected: "*",
	unselected: "o",
	success: "+",
	failure: "x",
	pending: ".",
	powerlineBranch: "",
	powerlineEdge: "",
};

const NERD: SymbolSet = {
	...UNICODE,
	// U+E0A0-range: Powerline separators. Only meaningful with a patched font, which is why
	// they are confined to the preset that opts into them.
	powerlineBranch: "",
	powerlineEdge: "",
};

const SETS: Record<SymbolPreset, SymbolSet> = {
	default: UNICODE,
	minimal: MINIMAL,
	ascii: ASCII_SET,
	nerd: NERD,
};

/**
 * What this terminal can be relied on to draw.
 *
 * Derived from platform and environment rather than probed: a glyph probe would mean waiting
 * on a response during startup, and the two signals that actually decide the question are
 * available before the first frame.
 */
export interface SymbolCapabilities {
	readonly platform: NodeJS.Platform;
	/** `COLORTERM`/`WT_SESSION` indicate a modern terminal on Windows. */
	readonly modernWindowsTerminal: boolean;
	/** `TERM` unset and a legacy console is the classic mojibake case. */
	readonly legacyWindowsConsole: boolean;
}

/** Read the environment once, so the decision is stable for the session. */
export function detectTerminalCapabilities(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): SymbolCapabilities {
	const modern =
		env.COLORTERM === "truecolor" ||
		env.COLORTERM === "24bit" ||
		env.WT_SESSION !== undefined ||
		env.TERM_PROGRAM === "vscode" ||
		env.TERM_PROGRAM === "WezTerm";
	// A Windows console without a modern-terminal marker, and with TERM unset, is the
	// codepage-437 case where box-drawing arrives as replacement characters.
	const legacy = platform === "win32" && !modern && (env.TERM === undefined || env.TERM === "");
	return { platform, modernWindowsTerminal: modern, legacyWindowsConsole: legacy };
}

/**
 * The preset this terminal should use when the user has expressed no preference.
 *
 * ASCII on a legacy console is the only choice that cannot render as garbage; otherwise
 * `default`, which is what the UI already assumes.
 */
export function detectSymbolPreset(capabilities: SymbolCapabilities = detectTerminalCapabilities()): SymbolPreset {
	return capabilities.legacyWindowsConsole ? "ascii" : "default";
}

/** Whether the platform can render the private-use Powerline glyphs at all. */
export function supportsNerdGlyphs(capabilities: SymbolCapabilities = detectTerminalCapabilities()): boolean {
	return capabilities.modernWindowsTerminal || capabilities.platform !== "win32";
}

export function symbolsFor(preset: SymbolPreset): SymbolSet {
	return SETS[preset] ?? UNICODE;
}

/**
 * The preset currently in effect.
 *
 * Set once at startup from settings, falling back to what the terminal can be trusted to
 * draw. Held here rather than threaded through every render call so a preset change does not
 * require re-plumbing the component tree, and so there is exactly one answer to "which glyphs
 * are we using" for the whole process.
 */
let activePreset: SymbolPreset | undefined;

/** Apply a preset. Called at startup and whenever the user changes the setting. */
export function setActiveSymbolPreset(preset: SymbolPreset): void {
	activePreset = preset;
}

/** The preset in effect, defaulting to what the terminal can draw. */
export function activeSymbolPreset(): SymbolPreset {
	activePreset ??= detectSymbolPreset();
	return activePreset;
}

/** The glyph set currently in effect. */
export function activeSymbols(): SymbolSet {
	return symbolsFor(activeSymbolPreset());
}
