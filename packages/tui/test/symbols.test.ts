import { describe, expect, it } from "vitest";
import {
	activeSymbolPreset,
	detectSymbolPreset,
	detectTerminalCapabilities,
	isSymbolPreset,
	SYMBOL_PRESETS,
	setActiveSymbolPreset,
	supportsNerdGlyphs,
	symbolsFor,
} from "../src/theme/symbols.ts";

/**
 * The symbol preset is only worth having if it changes what reaches the screen.
 *
 * These cover the properties that make the setting meaningful rather than decorative: the ASCII
 * preset must be pure ASCII (the only guarantee that renders on a codepage-437 console), every
 * preset must cover the same glyph names so a component never draws a gap, and the auto-detected
 * preset must land on ASCII exactly when the terminal cannot be trusted with box drawing.
 */

describe("symbol presets", () => {
	it("keeps ASCII pure ASCII", () => {
		// The whole point of the preset: a legacy console shows replacement characters for
		// anything outside its codepage, so every glyph must be inside 0x20-0x7E.
		for (const [name, glyph] of Object.entries(symbolsFor("ascii"))) {
			for (const character of glyph) {
				const code = character.codePointAt(0) ?? 0;
				expect(code, `${name} = ${JSON.stringify(character)} is not ASCII`).toBeLessThanOrEqual(0x7e);
				expect(code, `${name} = ${JSON.stringify(character)} is not printable ASCII`).toBeGreaterThanOrEqual(0x20);
			}
		}
	});

	it("offers every glyph in every preset", () => {
		// A preset missing a glyph would make a component render undefined or fall back to a
		// literal, reintroducing exactly the hard-coding this replaces.
		const expected = Object.keys(symbolsFor("default")).sort();
		for (const preset of SYMBOL_PRESETS) {
			expect(Object.keys(symbolsFor(preset)).sort(), `${preset} is missing glyphs`).toEqual(expected);
		}
	});

	it("reserves private-use glyphs for the nerd preset", () => {
		// Powerline shapes live in the private-use area, which renders as garbage on a terminal
		// without a patched font, so no other preset may use them.
		for (const preset of SYMBOL_PRESETS) {
			const set = symbolsFor(preset);
			const hasPrivateUse = [...set.powerlineBranch, ...set.powerlineEdge].some(
				(character) => (character.codePointAt(0) ?? 0) >= 0xe000,
			);
			expect(hasPrivateUse, `${preset} uses private-use glyphs`).toBe(preset === "nerd");
		}
	});

	it("uses Unicode box drawing by default", () => {
		expect(symbolsFor("default").horizontal).toBe("─");
		expect(symbolsFor("default").topLeft).toBe("╭");
	});

	it("recognises exactly its own vocabulary", () => {
		for (const preset of SYMBOL_PRESETS) expect(isSymbolPreset(preset)).toBe(true);
		for (const value of ["", "unicode", "Unicode", "nope"]) expect(isSymbolPreset(value)).toBe(false);
	});

	it("falls back to Unicode for an unknown preset", () => {
		// Defensive: a hand-edited settings.json must not blank the UI.
		expect(symbolsFor("nonsense" as never)).toBe(symbolsFor("default"));
	});
});

describe("terminal capability detection", () => {
	it("detects a legacy Windows console", () => {
		const capabilities = detectTerminalCapabilities({ TERM: "" }, "win32");
		expect(capabilities.legacyWindowsConsole).toBe(true);
	});

	it("does not treat a modern Windows terminal as legacy", () => {
		expect(detectTerminalCapabilities({ WT_SESSION: "1" }, "win32").legacyWindowsConsole).toBe(false);
		expect(detectTerminalCapabilities({ COLORTERM: "truecolor" }, "win32").legacyWindowsConsole).toBe(false);
		expect(detectTerminalCapabilities({ TERM_PROGRAM: "vscode" }, "win32").legacyWindowsConsole).toBe(false);
	});

	it("never treats a non-Windows terminal as a legacy console", () => {
		// TERM unset is normal on Linux and macOS and says nothing about glyph coverage.
		expect(detectTerminalCapabilities({}, "linux").legacyWindowsConsole).toBe(false);
		expect(detectTerminalCapabilities({}, "darwin").legacyWindowsConsole).toBe(false);
	});

	it("chooses ASCII only when the console cannot be trusted", () => {
		expect(detectSymbolPreset(detectTerminalCapabilities({ TERM: "" }, "win32"))).toBe("ascii");
		expect(detectSymbolPreset(detectTerminalCapabilities({ WT_SESSION: "1" }, "win32"))).toBe("default");
		expect(detectSymbolPreset(detectTerminalCapabilities({}, "linux"))).toBe("default");
	});

	it("gates nerd glyphs on the platform being able to draw them", () => {
		expect(supportsNerdGlyphs(detectTerminalCapabilities({}, "linux"))).toBe(true);
		expect(supportsNerdGlyphs(detectTerminalCapabilities({ TERM: "" }, "win32"))).toBe(false);
	});
});

describe("active preset", () => {
	it("reports what was set", () => {
		setActiveSymbolPreset("ascii");
		expect(activeSymbolPreset()).toBe("ascii");
		setActiveSymbolPreset("nerd");
		expect(activeSymbolPreset()).toBe("nerd");
		setActiveSymbolPreset("default");
		expect(activeSymbolPreset()).toBe("default");
	});

	it("defaults to what the terminal can draw rather than to Unicode blindly", () => {
		// Resets the memoised value, so the next read goes back through detection.
		setActiveSymbolPreset(detectSymbolPreset(detectTerminalCapabilities({ TERM: "" }, "win32")));
		expect(activeSymbolPreset()).toBe("ascii");
		setActiveSymbolPreset("default");
	});
});
