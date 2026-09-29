/**
 * The ask tool: how a model puts a question to the user.
 *
 * ## Why option labels are a security boundary
 *
 * The dialog adds reserved rows of its own - "Other (type your own)", "Chat
 * about this", "Next" - and each drives a distinct branch: custom input, a
 * side conversation, advancing a wizard.
 *
 * A model-supplied label that *collides* with one of those does not merely look
 * wrong. Selecting it takes the reserved branch instead of the intended one: a
 * model that offers "Other (type your own)" as a real answer opens a text box
 * the user did not expect, and a wizard advances a step nobody chose.
 *
 * So labels are validated against the reserved set rather than trusted, and the
 * check happens after normalisation - see below.
 *
 * ## Normalisation first, because a raw string is not what is compared
 *
 * Labels are sanitised before they are shown: carriage returns and newlines
 * are collapsed to spaces. That is correct for display and dangerous for
 * comparison, because `Other\r(type your own)` and `Other (type your own)`
 * normalise to the same thing. Validating the *raw* label would let a crafted
 * one through and the collision would happen at render time instead.
 *
 * So the check runs on the normalised form, and fails closed like any other
 * schema validation.
 *
 * ## The recommended option is an index, not a label
 *
 * An index cannot be crafted into a reserved label, and it survives a relabel.
 * A model that wants to suggest an answer points at a position.
 */

/** The row that opens a free-text box. */
export const OTHER_OPTION = "Other (type your own)";

/** The row that opens a side conversation about the question. */
export const CHAT_ABOUT_THIS_OPTION = "Chat about this";

/** The row that advances a wizard. */
export const NEXT_OPTION = "Next →";

/** Labels the dialog owns. A model-supplied label may not be one of these. */
export const RESERVED_OPTION_LABELS: Readonly<Record<string, true>> = {
	[OTHER_OPTION]: true,
	[CHAT_ABOUT_THIS_OPTION]: true,
	[NEXT_OPTION]: true,
};

/** One option a model offers. */
export interface AskOption {
	readonly label: string;
	readonly description?: string;
}

/** The question being asked. */
/** One row in the dialog, which may be a model option or one the dialog adds. */
export interface DialogRow {
	readonly label: string;
	readonly kind: "option" | "other" | "chat" | "next";
	/** Index into the options the model offered, or -1 for a dialog-added row. */
	readonly index: number;
}

export interface AskQuestion {
	readonly question: string;
	/** An optional chip shown beside the question. */
	readonly header?: string;
	readonly options: readonly (string | AskOption)[];
	/** Whether the user may pick more than one. */
	readonly multi?: boolean;
	/** Zero-based index of the option to preselect. */
	readonly recommended?: number;
}

/** The label of an option, whether given as a string or an object. */
export function optionLabel(option: string | AskOption): string {
	return typeof option === "string" ? option : option.label;
}

/**
 * The label as it will be shown and compared.
 *
 * Control characters collapse to spaces, so `Other\r(type your own)` and
 * `Other (type your own)` become the same string. Validating before this point
 * would let a crafted label through and the collision would happen at render time.
 */
export function normalizeLabel(label: string): string {
	return label
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export type AskValidation =
	| { readonly ok: true; readonly question: AskQuestion }
	| { readonly ok: false; readonly reason: string };

/**
 * Validates a question before it reaches the dialog.
 *
 * Fails closed. A rejected question is a model error the user sees, which is
 * better than a dialog that takes a branch nobody chose.
 */
export function validateAskQuestion(question: AskQuestion): AskValidation {
	const text = question.question.trim();
	if (text.length === 0) return { ok: false, reason: "the question has no text" };
	if (question.options.length === 0) {
		// A question with no options is a statement. The dialog would show the user
		// a title and nothing to answer.
		return { ok: false, reason: "the question offers no options to choose from" };
	}

	for (const option of question.options) {
		const normalized = normalizeLabel(optionLabel(option));
		if (normalized.length === 0) return { ok: false, reason: "an option has an empty label" };
		if (RESERVED_OPTION_LABELS[normalized]) {
			// Selecting this would take the reserved branch instead of the intended
			// one: a text box the user did not expect, or a wizard advancing a step
			// nobody chose.
			return {
				ok: false,
				reason: `the option label "${normalized}" is reserved by the dialog and must be defined with a label that does not collide`,
			};
		}
	}

	const labels = question.options.map((option) => normalizeLabel(optionLabel(option)));
	const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
	if (duplicate) {
		// Two identical rows make the returned index ambiguous, so a model that asked
		// for the second would get the first.
		return { ok: false, reason: `two options share the label "${duplicate}"` };
	}

	if (question.recommended !== undefined) {
		if (
			!Number.isInteger(question.recommended) ||
			question.recommended < 0 ||
			question.recommended >= question.options.length
		) {
			// A bad index preselects nothing, or worse, a row the model did not offer.
			return {
				ok: false,
				reason: `the recommended index ${question.recommended} is not one of the offered options`,
			};
		}
	}

	return { ok: true, question: { ...question, question: text } };
}

/** The options the dialog will actually show, including the reserved rows. */
export function dialogRows(question: AskQuestion): DialogRow[] {
	const rows: DialogRow[] = question.options.map((option, index) => ({
		label: normalizeLabel(optionLabel(option)),
		kind: "option" as const,
		index,
	}));
	if (question.multi) {
		// Only a multiple-choice question gets the free-text row: with one answer
		// expected, a text box is a second way to say the same thing and doubles the
		// rows a user reads.
		rows.push({ label: OTHER_OPTION, kind: "other", index: -1 });
	}
	return rows;
}

/** Whether selecting a row should open the free-text box. */
export function isCustomInputRow(label: string): boolean {
	return normalizeLabel(label) === OTHER_OPTION;
}
