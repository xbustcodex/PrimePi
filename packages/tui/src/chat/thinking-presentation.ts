/**
 * How a model's reasoning is presented.
 *
 * ## Four settings, and they are not four faces of one thing
 *
 * - **hide** — do not render thinking blocks at all. The reasoning still
 *   happened and still counted against the context; this only changes what the
 *   user sees.
 * - **prose-only** — render the reasoning but drop code blocks from it. Reasoning
 *   about code quotes the code, and a transcript of a long file appears twice:
 *   once as the read result and once inside the thinking. This removes the
 *   duplicate without losing the argument.
 * - **omit** — ask the provider not to produce thinking summaries at all, where
 *   it supports that. This is the only one that saves tokens rather than
 *   screen space.
 * - **external** — treat reasoning as a private scratchpad, never shown. It
 *   *disables* reasoning on the providers that support it, because a scratchpad
 *   the user cannot see but the provider still emits is neither.
 *
 * ## The distinction that matters
 *
 * Hiding and omitting are different in the direction that matters: hiding
 * removes tokens from the *screen*, omitting removes them from the *request*.
 * A user who wants a smaller context window needs `omit`; a user who finds
 * reasoning distracting needs `hide`. Treating them as one setting is how a
 * user sets "hide" and wonders why the bill is unchanged.
 *
 * ## Prose-only is an elision, not a deletion
 *
 * A dropped code block is replaced by a marker, not removed silently. The
 * reasoning around it usually says what the code was for, and a gap with no
 * marker reads as a rendering fault rather than a decision.
 */

/** What the user asked for. */
export interface ThinkingPresentationSettings {
	/** Do not render thinking blocks. */
	readonly hideThinkingBlock: boolean;
	/** Drop code blocks from a rendered thinking summary. */
	readonly proseOnlyThinking: boolean;
	/** Ask the provider to omit thinking summaries entirely. */
	readonly omitThinking: boolean;
	/** Private scratchpad: never shown, and reasoning disabled where supported. */
	readonly externalThinking: boolean;
}

export const DEFAULT_THINKING_PRESENTATION: ThinkingPresentationSettings = {
	hideThinkingBlock: false,
	proseOnlyThinking: true,
	omitThinking: false,
	externalThinking: false,
};

/** What a rendered thinking block should show. */
export type ThinkingDisplay =
	| { readonly kind: "hidden" }
	| { readonly kind: "prose"; readonly text: string; readonly elided: readonly string[] }
	| { readonly kind: "raw"; readonly text: string };

/** The marker standing in for an elided code block. */
export const ELIDED_CODE_MARKER = "…code elided…";

/** A fenced code block, or an XML block the provider emitted. */
const CODE_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~|<([a-zA-Z][\w.-]*)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Replaces every code block in a thinking summary with a marker. */
export function toProseOnly(text: string): { text: string; elided: string[] } {
	const elided: string[] = [];
	// A fresh regex per call: the global flag makes `lastIndex` stateful, and a
	// shared one would skip every other block on the second rendering of the same
	// text.
	const replaced = text.replace(new RegExp(CODE_BLOCK.source, "g"), (match) => {
		// The language tag is worth keeping: "ts" tells a reader what was elided
		// without giving back the body.
		const language = /^```([a-zA-Z0-9+#-]*)/.exec(match)?.[1];
		elided.push(language ? `${language} block` : "code block");
		return language ? `${ELIDED_CODE_MARKER} (${language})` : ELIDED_CODE_MARKER;
	});
	return { text: replaced, elided };
}

/** What to render for one thinking block. */
export function resolveThinkingDisplay(thinking: string, settings: ThinkingPresentationSettings): ThinkingDisplay {
	// External is checked first: a scratchpad is never shown, whatever else is set.
	if (settings.externalThinking) return { kind: "hidden" };
	if (settings.hideThinkingBlock) return { kind: "hidden" };
	if (!settings.proseOnlyThinking) return { kind: "raw", text: thinking };
	const { text, elided } = toProseOnly(thinking);
	return { kind: "prose", text, elided };
}

/** What the settings do to the request rather than the screen. */
export interface RequestEffect {
	/** Ask the provider to omit thinking summaries. */
	readonly omitReasoning: boolean;
	/** Reasoning is not requested at all, as for a private scratchpad. */
	readonly disableReasoning: boolean;
	/**
	 * Whether reasoning is requested, which is not the same as whether it is shown.
	 * Separated because "hide" must not change what the provider is asked for.
	 */
	readonly requestReasoning: boolean;
}

/** What a settings combination does to the outgoing request. */
export function requestEffect(settings: ThinkingPresentationSettings): RequestEffect {
	if (settings.externalThinking) {
		// A scratchpad the user cannot see but the provider still emits is neither,
		// so reasoning is disabled where the provider supports it.
		return { omitReasoning: true, disableReasoning: true, requestReasoning: false };
	}
	if (settings.omitThinking) {
		// The only setting that saves tokens: the summaries are never produced.
		return { omitReasoning: true, disableReasoning: false, requestReasoning: true };
	}
	// Hiding changes the screen, not the request. Conflating the two is how a user
	// sets "hide" and wonders why the bill is unchanged.
	return { omitReasoning: false, disableReasoning: false, requestReasoning: true };
}

/** One line for a settings hint, naming what the setting actually changes. */
export function describePresentation(
	key: keyof ThinkingPresentationSettings,
	settings: ThinkingPresentationSettings,
): string {
	switch (key) {
		case "hideThinkingBlock":
			return settings.hideThinkingBlock
				? "Thinking is not rendered. The provider still produces it and it still costs tokens."
				: "Thinking is rendered as the provider produced it.";
		case "proseOnlyThinking":
			return settings.proseOnlyThinking
				? "Code blocks inside a thinking summary are replaced by a marker; the surrounding reasoning is kept."
				: "Thinking summaries are shown verbatim, code blocks included.";
		case "omitThinking":
			return settings.omitThinking
				? "The provider is asked to omit thinking summaries, where it supports doing so."
				: "Thinking summaries are requested as usual.";
		case "externalThinking":
			return settings.externalThinking
				? "Reasoning is a private scratchpad: never shown, and disabled where the provider supports it."
				: "Reasoning is not treated as a scratchpad.";
	}
}
