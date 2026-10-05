/**
 * Theme colour and background token vocabulary.
 *
 * Moved here from the coding-agent package so `tui` owns the vocabulary every surface needs.
 *
 * The reference keeps its theme inside `pi-tui`; Prime Pi's theme lives in coding-agent. That
 * split is workable for a theme that only draws in one package, but it makes every ported OMP
 * overlay unreachable: `native/spans.ts` and `native/tone.ts` need these token names and
 * `isValidThemeColor` to resolve a semantic span to a colour, and there was no way for tui to
 * reach them without inverting the package dependency.
 *
 * The vocabulary is a plain union, so it belongs in the lower package. The `Theme` class stays
 * in coding-agent, where the colour resolution and the `#RRGGBBAA` parsing fixes live.
 */

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "scrollbarTrack"
	| "scrollbarThumb"
	| "searchMatchText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

export type ThemeToken = ThemeColor | ThemeBg;

const THEME_COLOR_SET: ReadonlySet<string> = new Set<ThemeColor>([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"scrollbarTrack",
	"scrollbarThumb",
	"searchMatchText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
]);

/** Narrowing guard for a colour name arriving from theme JSON or a semantic span. */
export function isValidThemeColor(value: string): value is ThemeColor {
	return THEME_COLOR_SET.has(value);
}
