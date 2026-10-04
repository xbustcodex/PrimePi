import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightCode, initTheme, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	highlight,
	loadAllHighlightLanguages,
	renderHighlightedHtml,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

const eagerLanguages = [
	"python",
	"java",
	"go",
	"javascript",
	"cpp",
	"typescript",
	"php",
	"ruby",
	"c",
	"csharp",
	"nix",
	"bash",
	"rust",
	"scala",
	"kotlin",
	"swift",
	"dart",
	"groovy",
	"perl",
	"lua",
];
const eagerLanguagesLoadedAtStartup = eagerLanguages.every(supportsLanguage);
const uncommonLanguageLoadedAtStartup = supportsLanguage("ada");

describe("syntax highlight renderer", () => {
	it("loads the twenty most common languages at startup and defers the rest", async () => {
		expect(eagerLanguagesLoadedAtStartup).toBe(true);
		expect(uncommonLanguageLoadedAtStartup).toBe(false);
		await loadAllHighlightLanguages();
		expect(supportsLanguage("ada")).toBe(true);
	});

	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("theme syntax highlighting", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	// The expected colours are resolved from the theme that is actually active, rather than
	// written out as literal RGB. They used to be literals copied from the `dark.json` that
	// predated 0382c0fab; the OMP theme inventory replaced that file and the assertions stopped
	// describing the product without anyone noticing. Resolving them keeps the test asserting
	// what it means - a deletion is painted in the theme's diff-removed colour - and it cannot
	// go stale again when a theme is re-imported.
	function themed(text: string, colour: ThemeColor): string {
		return theme.fg(colour, text);
	}

	it("paints an unsupported language uniformly in the code-block colour", () => {
		// `diff` is not a language cli-highlight knows, so `highlightCode` deliberately falls
		// through to one colour for the whole block rather than emitting unstyled text. This
		// was previously asserted as "colors diff additions and deletions", with two different
		// literals for the two lines - a claim the code does not make.
		//
		// It only holds while `diff` is unsupported: the test above calls
		// `loadAllHighlightLanguages()`, after which `diff` becomes a real language and this
		// block is tokenized per line instead. The expectation is therefore scoped to the
		// unsupported case, which is what the fallback is for.
		const rendered = highlightCode("-old\n+new", "not-a-real-language");
		expect(rendered).toEqual(["-old", "+new"].map((line) => themed(line, "mdCodeBlock")));
	});

	it("paints a supported language per scope", () => {
		// The point of the mapping table: a real language resolves its scopes through the theme.
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(themed("/foo+/gi", "syntaxString"));
	});

	it("maps the remaining default styled scopes to theme styles", () => {
		expect(highlightCode("@decorator", "python")[0]).toBe(themed("@decorator", "muted"));
		expect(highlightCode("<div></div>", "html")[0]).toContain(themed("div", "syntaxKeyword"));
	});
});
