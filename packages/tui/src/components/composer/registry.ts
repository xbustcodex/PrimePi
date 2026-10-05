import { bandComposerStyle } from "./band.ts";
import { borderlessComposerStyle } from "./borderless.ts";
import { boxComposerStyle } from "./box.ts";
import { claudeComposerStyle } from "./claude.ts";
import { fieldComposerStyle } from "./field.ts";
import { piComposerStyle } from "./pi.ts";
import { railComposerStyle } from "./rail.ts";
import { ruleComposerStyle } from "./rule.ts";
import type { ComposerStyle, EditorBorderStyle } from "./types.ts";

const BUILTIN_COMPOSER_STYLES: Readonly<Record<string, ComposerStyle>> = {
	box: boxComposerStyle,
	band: bandComposerStyle,
	claude: claudeComposerStyle,
	pi: piComposerStyle,
	borderless: borderlessComposerStyle,
	rule: ruleComposerStyle,
	field: fieldComposerStyle,
	rail: railComposerStyle,
};
const extensionComposerStyles = new Map<string, ComposerStyle>();

/** Whether an id names a composer style shipped by pi-tui. */
export function isBuiltinComposerStyle(id: string): boolean {
	return Object.hasOwn(BUILTIN_COMPOSER_STYLES, id);
}

/**
 * Whether a style paints its own row foreground.
 *
 * Extensions registered before `filledSurface` existed received undecorated
 * row text, so an omitted flag remains filled for extension-owned ids.
 */
export function isFilledComposerStyle(style: ComposerStyle): boolean {
	return style.filledSurface ?? !isBuiltinComposerStyle(style.id);
}

/**
 * Register one extension-owned composer style for this process.
 *
 * Built-in ids and duplicate extension ids are rejected. The returned disposer
 * removes only this registration.
 */
export function registerComposerStyle(style: ComposerStyle): () => void {
	const id = style.id.trim();
	if (id.length === 0 || id !== style.id) throw new TypeError("Composer style id must be a non-empty trimmed string");
	if (isBuiltinComposerStyle(id)) throw new Error(`Cannot replace built-in composer style "${id}"`);
	if (extensionComposerStyles.has(id)) throw new Error(`Composer style "${id}" is already registered`);
	extensionComposerStyles.set(id, style);
	return () => {
		if (extensionComposerStyles.get(id) === style) extensionComposerStyles.delete(id);
	};
}

/** Style object for a composer shape; unknown ids fall back to `box`. */
export function getComposerStyle(id: EditorBorderStyle): ComposerStyle {
	return extensionComposerStyles.get(id) ?? BUILTIN_COMPOSER_STYLES[id] ?? boxComposerStyle;
}
