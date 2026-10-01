import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeybindingsManager } from "../src/core/keybindings.ts";

/**
 * A key bound to two actions costs the user one of them, silently.
 *
 * `CustomEditor.handleInput` walks `actionHandlers` in insertion order and returns on
 * the first `keybindings.matches(...)` hit, so when a user's `keybindings.json` puts
 * two actions on one key, the second never runs. `KeybindingsManager` has detected this
 * since `getConflicts` was written and nothing read it — the interactive mode now
 * surfaces it in the loaded-resources diagnostics panel.
 *
 * Asserted through the live manager, because the defect is in the manager's *reporting*
 * reaching no one, not in the detection.
 */
describe("keybinding conflicts", () => {
	it("reports a key bound to two actions", () => {
		const manager = new KeybindingsManager({
			"app.model.select": "ctrl+g",
			"app.editor.external": "ctrl+g",
		} as never);

		const conflicts = manager.getConflicts();
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0].key, "ctrl+g");
		assert.deepEqual([...conflicts[0].keybindings].sort(), ["app.editor.external", "app.model.select"]);
	});

	it("both actions match one keystroke, so one is unreachable", () => {
		// This is the fact that makes the conflict worth reporting: detection alone is
		// harmless, but the dispatch order means the user has silently lost an action.
		const manager = new KeybindingsManager({
			"app.model.select": "ctrl+g",
			"app.editor.external": "ctrl+g",
		} as never);

		// ctrl+g reaches the terminal as the control byte 0x07.
		const ctrlG = "";
		assert.equal(manager.matches(ctrlG, "app.model.select"), true);
		assert.equal(manager.matches(ctrlG, "app.editor.external"), true);
	});

	it("reports nothing for a key bound to one action", () => {
		const manager = new KeybindingsManager({ "app.model.select": "ctrl+g" } as never);
		assert.deepEqual(manager.getConflicts(), []);
	});
});
