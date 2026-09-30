import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Cleared-draft recall, through the editor the composer actually is.
 *
 * The setting this serves (`composer.recallClearedDrafts`) is read by the host,
 * so the test drives `clearDraft({ recall })` — the same call the ctrl+c clear
 * path makes — and observes the only thing a user can observe: whether
 * arrow-up gets the draft back.
 */

function createEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
}

const UP = "\x1b[A";

describe("a cleared draft is recoverable when the host asks for recall", () => {
	it("offers the discarded draft to arrow-up", () => {
		const editor = createEditor();
		editor.setText("half-written thought");
		editor.clearDraft({ recall: true });

		assert.strictEqual(editor.getText(), "");
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "half-written thought");
	});

	it("discards it permanently when the host does not ask for recall", () => {
		const editor = createEditor();
		editor.setText("half-written thought");
		editor.clearDraft({ recall: false });

		assert.strictEqual(editor.getText(), "");
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "");
	});

	it("records nothing for an empty composer, so arrow-up has no blank to skip", () => {
		const editor = createEditor();
		editor.setText("   ");
		editor.clearDraft({ recall: true });
		editor.addToHistory("earlier prompt");

		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "earlier prompt");
		editor.handleInput(UP);
		// Holding at the oldest entry is the proof: had the blank been recorded,
		// this second press would have surfaced it.
		assert.strictEqual(editor.getText(), "earlier prompt", "no empty entry was pushed into recall history");
	});

	it("governs future clears only: a draft recorded while on stays recallable", () => {
		const editor = createEditor();
		editor.setText("recorded while on");
		editor.clearDraft({ recall: true });

		// The host now reads the setting as off. The past is not rewritten.
		editor.setText("recorded while off");
		editor.clearDraft({ recall: false });

		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "recorded while on");
		// Past the oldest entry there is nothing older, so arrow-up holds rather
		// than falling back to empty — the editor is browsing, not editing.
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "recorded while on");
	});

	it("keeps submitted prompts ahead of discarded drafts", () => {
		const editor = createEditor();
		editor.addToHistory("sent this");
		editor.setText("abandoned this");
		editor.clearDraft({ recall: true });

		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "sent this", "a prompt the user sent is the first thing arrow-up offers");
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "abandoned this");
	});
});
