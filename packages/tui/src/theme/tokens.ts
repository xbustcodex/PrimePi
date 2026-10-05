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
	| "bashMode"
	// Present in the shipped themes and used by the status line, but absent from the union.
	| "statusLineSep";

export type ThemeBg =
	| "selectedBg"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	// Present in Prime Pi's own settings rows and status line, but missing from the union until
	// the native layer needed it. `tone.ts` resolves it, and without the token the union was
	// narrower than the themes that ship.
	| "statusLineBg";

export type ThemeToken = ThemeColor | ThemeBg;

/**
 * Colour tokens in schema order.
 *
 * Basic tokens (`accent`, `success`, …) precede derived ones, so reverse-mapping an SGR escape
 * back to a token resolves ties toward the more specific token. The reference reads this order
 * from its `dark.json` key order; Prime Pi's theme files live in the coding-agent package, so the
 * order is declared here alongside the vocabulary and exported for that purpose.
 */
export const THEME_COLOR_ORDER: readonly ThemeColor[] = [
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
	"statusLineSep",
];

const THEME_COLOR_SET: ReadonlySet<string> = new Set<ThemeColor>(THEME_COLOR_ORDER);

/** Narrowing guard for a colour name arriving from theme JSON or a semantic span. */
export function isValidThemeColor(value: string): value is ThemeColor {
	return THEME_COLOR_SET.has(value);
}
