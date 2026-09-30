import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractInlineSloppyRegions, recoverInlineSloppyEdit } from "../src/harness/session/inline-edit-recovery.ts";

/**
 * Inline edit recovery.
 *
 * The dangerous cases are the ones where recovering is wrong: a truncated
 * payload, a turn that already called the edit tool, and a model *discussing*
 * the syntax. Each of those would otherwise apply an edit nobody asked for.
 */

const HEADER = "*** Edit File: src/index.ts";

function message(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
		...extra,
	} as unknown as AssistantMessage;
}

describe("region detection", () => {
	it("finds a payload introduced by the header", () => {
		const text = `Some prose first.\n\n${HEADER}\nconst a = 1;\n`;
		const regions = extractInlineSloppyRegions(text);
		expect(regions).toHaveLength(1);
		expect(regions[0]!.payload).toContain(HEADER);
	});

	it("finds two separate payloads as two regions", () => {
		// Merging them would produce one edit containing both file headers, which
		// the edit tool would reject or misapply.
		const text = `${HEADER}\nconst a = 1;\n*** Add File: src/other.ts\nconst b = 2;\n`;
		expect(extractInlineSloppyRegions(text)).toHaveLength(2);
	});

	it("ignores prose that merely mentions the syntax", () => {
		// A model explaining the format is discussing an edit, not issuing one.
		expect(extractInlineSloppyRegions("You can write *** Edit File: path to edit a file.")).toHaveLength(0);
	});

	it("returns nothing for ordinary prose", () => {
		expect(extractInlineSloppyRegions("just a normal answer about the code")).toHaveLength(0);
	});
});

describe("recovery fires only where it is safe", () => {
	it("lifts a payload into a synthetic edit tool call", () => {
		const payload = `${HEADER}\nconst a = 1;\n`;
		const m = message(`Here is the change.\n${payload}`);
		expect(recoverInlineSloppyEdit(m)).toBe(1);
		const call = m.content.find((block) => block.type === "toolCall");
		// Re-materialised as a tool call, so the normal pipeline handles it -
		// validation, approval tiering, execution and replay - unchanged.
		expect(call).toBeDefined();
		expect((call as { name: string }).name).toBe("edit");
		expect((call as unknown as { arguments: { input: string } }).arguments.input).toContain(HEADER);
	});

	it("keeps the prose that surrounded the payload", () => {
		const m = message(`Here is the change.\n${HEADER}\nconst a = 1;\n`);
		recoverInlineSloppyEdit(m);
		const text = m.content.find((block) => block.type === "text");
		expect((text as { text: string }).text).toContain("Here is the change.");
		expect((text as { text: string }).text).not.toContain(HEADER);
	});

	it("does not fire on a length-truncated turn", () => {
		// The model was cut off mid-write. Applying the fragment would corrupt a
		// file, and there is no way to know how much was lost.
		const m = message(`${HEADER}\nconst a = 1;`, { stopReason: "length" } as Partial<AssistantMessage>);
		expect(recoverInlineSloppyEdit(m)).toBe(0);
		expect(m.content.some((block) => block.type === "toolCall")).toBe(false);
	});

	it("does not fire when the turn already carries a tool call", () => {
		// That turn handled its own edits, so a payload quoted in it is commentary
		// about an edit, not the edit itself.
		const m = message(`As shown in my earlier edit:\n${HEADER}\nconst a = 1;\n`);
		m.content.push({
			type: "toolCall",
			id: "t1",
			name: "read",
			arguments: {},
		} as AssistantMessage["content"][number]);
		expect(recoverInlineSloppyEdit(m)).toBe(0);
		expect(m.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
	});

	it("does not fire on a turn that ended for another reason", () => {
		expect(
			recoverInlineSloppyEdit(
				message(`${HEADER}\nconst a = 1;`, { stopReason: "aborted" } as Partial<AssistantMessage>),
			),
		).toBe(0);
	});

	it("leaves an ordinary answer untouched", () => {
		const m = message("The function returns the sum of its arguments.");
		expect(recoverInlineSloppyEdit(m)).toBe(0);
		expect(m.content).toHaveLength(1);
		expect(m.content[0]).toEqual({ type: "text", text: "The function returns the sum of its arguments." });
	});

	it("does not leave a blank text block behind", () => {
		// A block emptied by the lift would render as an empty turn.
		const m = message(`${HEADER}\nconst a = 1;\n`);
		recoverInlineSloppyEdit(m);
		const blanks = m.content.filter((block) => block.type === "text" && block.text.trim() === "");
		expect(blanks).toHaveLength(0);
	});

	it("joins multiple payloads into one call rather than two", () => {
		// Two edits in one turn is one model decision, and the reference emits a
		// single synthetic call.
		const m = message(`${HEADER}\nconst a = 1;\n*** Add File: src/other.ts\nconst b = 2;\n`);
		expect(recoverInlineSloppyEdit(m)).toBe(2);
		expect(m.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
	});
});
