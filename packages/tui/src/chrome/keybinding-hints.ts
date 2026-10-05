/**
 * Utilities for formatting keybinding hints in the UI.
 */

// The reference imports these from `app-keybindings.ts`, which is 667 lines of keybinding file
// I/O and config parsing. Only the formatting is needed to render a hint, and that already lives
// in `key-hint-format.ts` - so the heavyweight module is not a dependency of the chrome layer.
import { formatKeyHint, formatKeyHints, type KeyName } from "../key-hint-format.ts";
import { getKeybindings, type Keybinding } from "../keybindings.ts";
import type { KeyId } from "../keys.ts";
import { theme } from "../theme/index.ts";

/**
 * Primary (first) key bound to an editor action, formatted for footer hints;
 * empty when unbound. Full alternatives: `formatKeyHints(getKeybindings().getKeys(action))`.
 */
export function editorKey(action: Keybinding): string {
	const [key] = getKeybindings().getKeys(action);
	return key ? formatKeyHint(key) : "";
}

/** Primary keys of several actions, slash-joined: `editorKeys("tui.select.up", "tui.select.down")` → `↑/↓`. */
export function editorKeys(...actions: Keybinding[]): string {
	return actions.map(editorKey).join("/");
}

/**
 * Keys bound to `action`, or `fallback` when the active registry has none — a
 * TUI-only registry carries no `app.*` bindings. Mirrors the fallbacks in
 * `keybinding-matchers.ts`, so hints name the keys the matcher accepts.
 */
export function boundKeys(action: Keybinding, fallback: readonly KeyId[]): readonly KeyId[] {
	const keys = getKeybindings().getKeys(action);
	return keys.length > 0 ? keys : fallback;
}

/**
 * Format a keybinding hint with consistent styling: dim key, muted description.
 * Looks up the key from editor keybindings automatically.
 *
 * @param action - Keybinding action name (e.g., "tui.select.confirm", "app.tools.expand")
 * @param description - Description text (e.g., "to expand", "cancel")
 * @returns Formatted string with dim key and muted description
 */
export function keyHint(action: Keybinding, description: string): string {
	return theme.fg("dim", editorKey(action)) + theme.fg("muted", ` ${description}`);
}

/**
 * Format a hint for fixed (non-configurable) keys, e.g. `rawKeyHint(["up", "down"], "navigate")`.
 * Alternatives render slash-separated (see {@link formatKeyHints}).
 */
export function rawKeyHint(keys: KeyName | readonly KeyName[], description: string): string {
	return theme.fg("dim", formatKeyHints(keys)) + theme.fg("muted", ` ${description}`);
}
