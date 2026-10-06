/**
 * Active theme's symbol lookup without importing `./theme` (which pulls the
 * native addon through `@oh-my-pi/pi-natives`). Key-hint formatting runs on
 * CLI paths that must stay addon-free (`omp --version`, help), so it reads the
 * active theme through this mirror; `./theme` publishes every assignment here.
 */
import { SYMBOL_PRESETS, type SymbolKey } from "./symbols.ts";

/**
 * Structural view of the active theme.
 *
 * The reference imports its `Theme` class from `./theme-class`. Prime Pi's `Theme` lives in the
 * coding-agent package, not in tui, so importing it here would invert the dependency. Only
 * `symbol(key)` is ever called through this mirror, so that is the whole contract.
 */
interface SymbolSource {
	/**
	 * A dotted symbol name.
	 *
	 * Any string, not only a declared key: the theme accepts whatever a component asks for and
	 * falls back, so narrowing this to `SymbolKey` would force every caller to cast.
	 */
	symbol(key: string): string;
}

let active: SymbolSource | undefined;

/** @internal Called by `./theme` whenever the active theme changes. */
export function setActiveSymbolTheme(value: SymbolSource | undefined): void {
	active = value;
}

/** Symbol from the active theme, or the ascii preset before any theme loads. */
export function activeThemeSymbol(key: SymbolKey): string {
	return active ? active.symbol(key) : SYMBOL_PRESETS.ascii[key];
}
