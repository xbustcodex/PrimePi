import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * Trust decisions.
 *
 * The fixtures use real directories rather than POSIX-looking literals. The component
 * resolves the cwd before building its options - `normalizeCwd` -> `resolvePath` ->
 * `canonicalizePath` - so `/project` becomes `C:\project` on Windows. The product is
 * right: a trust decision has to be recorded against a path that can be looked up
 * later, and the resolved absolute path is that path. The literals were asserting the
 * unresolved spelling, so these tests were checking path formatting rather than trust
 * behaviour.
 */
function realDir(name: string): string {
	const dir = join(tmpdir(), `trust-sel-${name}-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const project = realDir("project");
		const selector = new TrustSelectorComponent({
			cwd: project,
			savedDecision: { path: project, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (${project})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("→ ✓ Trust");

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ Trust");
		// Moving down once lands on "Trust parent folder", whose path is the real parent
		// of the project directory.
		expect(output).toContain(`→   Trust parent folder (${dirname(project)})`);
		expect(output).not.toContain("✓ Do not trust");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const project = realDir("project");
		const selector = new TrustSelectorComponent({
			cwd: project,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: project, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const parent = realDir("parent");
		const nested = join(parent, "project", "nested");
		mkdirSync(nested, { recursive: true });
		const selector = new TrustSelectorComponent({
			cwd: nested,
			savedDecision: { path: parent, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${parent})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const parent = realDir("parent");
		const project = join(parent, "project");
		mkdirSync(project, { recursive: true });
		const selector = new TrustSelectorComponent({
			cwd: project,
			savedDecision: { path: parent, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parent})`);
		expect(output).toContain(`✓ Trust parent folder (${parent})`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parent, decision: true },
				{ path: project, decision: null },
			],
		});
	});
});
