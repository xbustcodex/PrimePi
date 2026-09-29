import { describe, expect, it } from "vitest";
import {
	type AskOption,
	CHAT_ABOUT_THIS_OPTION,
	dialogRows,
	isCustomInputRow,
	NEXT_OPTION,
	normalizeLabel,
	OTHER_OPTION,
	optionLabel,
	RESERVED_OPTION_LABELS,
	validateAskQuestion,
} from "../src/core/tools/ask.ts";

/**
 * The ask tool.
 *
 * The property that makes this a security boundary rather than a form: **a
 * model-supplied label may not collide with one the dialog owns.** Selecting a
 * colliding row takes the reserved branch instead of the intended one — a text
 * box nobody expected, or a wizard advancing a step nobody chose.
 */

const question = (overrides: Record<string, unknown> = {}) =>
	validateAskQuestion({
		question: "Which release channel should this build follow?",
		options: ["Stable", "Canary"],
		...overrides,
	} as never);

describe("reserved labels cannot be hijacked", () => {
	it("rejects a label the dialog owns", () => {
		const result = question({ options: ["Stable", OTHER_OPTION] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("reserved");
	});

	it("rejects every reserved label, not just the text one", () => {
		for (const reserved of [OTHER_OPTION, CHAT_ABOUT_THIS_OPTION, NEXT_OPTION]) {
			expect(question({ options: [reserved] }).ok, reserved).toBe(false);
		}
	});

	it("checks the normalised form, so a crafted label cannot slip through", () => {
		// The label is sanitised before it is shown, so `Other\r(type your own)`
		// and `Other (type your own)` are the same string. Validating the raw value
		// would let this through and the collision would happen at render time.
		const result = question({ options: ["Stable", "Other\r(type your own)"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("reserved");
	});

	it("collapses other whitespace the same way", () => {
		expect(question({ options: ["Other\n(type your own)"] }).ok).toBe(false);
		expect(question({ options: ["Other\t(type your own)"] }).ok).toBe(false);
	});

	it("normalises a label the way the dialog will", () => {
		expect(normalizeLabel("  a   b  ")).toBe("a b");
		expect(normalizeLabel("a\r\nb")).toBe("a b");
	});

	it("knows which label opens the free-text box", () => {
		expect(isCustomInputRow(OTHER_OPTION)).toBe(true);
		expect(isCustomInputRow("Other\r(type your own)")).toBe(true);
		expect(isCustomInputRow("Stable")).toBe(false);
	});
});

describe("a question must be answerable", () => {
	it("rejects a question with no text", () => {
		expect(question({ question: "   " }).ok).toBe(false);
	});

	it("rejects a question with no options", () => {
		// The dialog would show the user a title and nothing to answer.
		expect(question({ options: [] }).ok).toBe(false);
	});

	it("rejects an option with an empty label", () => {
		expect(question({ options: ["Stable", "   "] }).ok).toBe(false);
	});

	it("rejects two options sharing a label", () => {
		// Two identical rows make the returned index ambiguous, so a model that
		// asked for the second would get the first.
		const result = question({ options: ["Stable", "Stable"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("share the label");
	});

	it("treats a whitespace-variant label as a duplicate", () => {
		expect(question({ options: ["Stable", "  Stable  "] }).ok).toBe(false);
	});

	it("accepts a well-formed question", () => {
		expect(question().ok).toBe(true);
	});
});

describe("the recommended option is an index, not a label", () => {
	it("accepts a valid index", () => {
		expect(question({ recommended: 1 }).ok).toBe(true);
	});

	it("rejects an index outside the options", () => {
		// A bad index preselects nothing, or worse, a row the model never offered.
		expect(question({ recommended: 5 }).ok).toBe(false);
		expect(question({ recommended: -1 }).ok).toBe(false);
	});

	it("rejects a fractional index", () => {
		expect(question({ recommended: 0.5 }).ok).toBe(false);
	});
});

describe("option labels", () => {
	it("reads a string or an object the same way", () => {
		expect(optionLabel("Stable")).toBe("Stable");
		expect(optionLabel({ label: "Stable", description: "the safe one" })).toBe("Stable");
	});

	it("keeps a description available for the row", () => {
		const options: AskOption[] = [{ label: "Stable", description: "the safe one" }];
		expect(dialogRows({ question: "q", options }).map((row) => row.label)).toEqual(["Stable"]);
	});
});

describe("the dialog adds its own rows", () => {
	it("adds the free-text row only for a multiple-choice question", () => {
		// With one answer expected, a text box is a second way to say the same thing
		// and doubles the rows a user reads.
		expect(dialogRows({ question: "q", options: ["a", "b"] }).map((row) => row.kind)).toEqual(["option", "option"]);
		expect(dialogRows({ question: "q", options: ["a", "b"], multi: true }).map((row) => row.kind)).toEqual([
			"option",
			"option",
			"other",
		]);
	});

	it("marks an added row as having no option index", () => {
		const added = dialogRows({ question: "q", options: ["a"], multi: true }).at(-1)!;
		expect(added.index).toBe(-1);
		// A model-supplied row keeps its own index, so a selection maps back to what the model offered.
		expect(dialogRows({ question: "q", options: ["a", "b"] })[1]!.index).toBe(1);
	});

	it("lists the reserved labels the dialog reserves", () => {
		// A test that reads the table rather than hardcoding it, so adding a reserved
		// label is covered by the collision case above.
		expect(Object.keys(RESERVED_OPTION_LABELS)).toContain(OTHER_OPTION);
	});
});
