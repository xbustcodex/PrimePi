import { describe, expect, it } from "vitest";
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
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].key).toBe("ctrl+g");
		expect([...conflicts[0].keybindings].sort()).toEqual(["app.editor.external", "app.model.select"]);
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
		expect(manager.matches(ctrlG, "app.model.select")).toBe(true);
		expect(manager.matches(ctrlG, "app.editor.external")).toBe(true);
	});

	it("reports nothing for a key bound to one action", () => {
		const manager = new KeybindingsManager({ "app.model.select": "ctrl+g" } as never);
		expect(manager.getConflicts()).toEqual([]);
	});
});
