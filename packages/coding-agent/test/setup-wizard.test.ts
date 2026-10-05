import type { Model } from "@earendil-works/pi-ai";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { ALL_SETUP_SCENES, setThemePreviewHook } from "../src/modes/setup/setup-scene-list.ts";
import type { ComposerShape, SetupHost, SymbolPreset, TerminalTheme } from "../src/modes/setup/setup-scenes.ts";
import { CURRENT_SETUP_VERSION } from "../src/modes/setup/setup-scenes.ts";
import { SetupWizard } from "../src/modes/setup/setup-wizard.ts";

/**
 * Scene behaviour, driven through the wizard frame rather than by poking scene internals.
 *
 * The properties under test are the ones a user would notice: every scene is reachable, every
 * scene commits through a production authority, an interrupted wizard records nothing, and a
 * completed one suppresses itself on the next launch.
 */

function model(id: string, provider: string, free = false): Model<string> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "",
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		free,
	} as unknown as Model<string>;
}

function makeHost(overrides: Partial<SetupHost> = {}): SetupHost {
	return {
		setupVersion: 0,
		configuredDarkTheme: undefined,
		configuredLightTheme: undefined,
		detectedAppearance: "dark",
		symbolPreset: "default",
		composerShape: "rounded",
		colorBlindMode: false,
		disabledProviders: [],
		availableThemes: ["titanium", "dark-abyss", "light", "light-frost"],
		authenticatedProviders: () => ["anthropic"],
		allProviders: () => ["anthropic", "openai", "google"],
		getModels: () => [
			{ model: model("gpt-free", "openai", true), access: "credential-free", current: false },
			{ model: model("claude", "anthropic"), access: "authenticated", current: true },
		],
		refreshModels: async () => {},
		selectModel: async () => {},
		saveComposerShape: async () => {},
		saveSymbolPreset: async () => {},
		saveColorBlindMode: () => {},
		saveTheme: async () => {},
		markComplete: async () => {},
		showError: () => {},
		settings: {} as SetupHost["settings"],
		...overrides,
	} as SetupHost;
}

/**
 * Drive the real wizard rather than a hand-rolled scene loop.
 *
 * The first version of this harness advanced scenes with its own `finish` callback, which meant
 * it never exercised the frame that actually sequences them - and reported failures that were
 * artefacts of the harness. The frame is the thing under test, so it is the thing driven.
 */
async function mountAll(host: SetupHost) {
	const onComplete = vi.fn(async () => {});
	const onCancel = vi.fn();
	const wizard = new SetupWizard({
		ctx: host,
		scenes: ALL_SETUP_SCENES,
		terminalRows: 40,
		terminalColumns: 100,
		onComplete,
		onCancel,
		requestRender: () => {},
	});
	return {
		wizard,
		onComplete,
		get index() {
			return wizard.position.index;
		},
		get scene(): (typeof ALL_SETUP_SCENES)[number] {
			// The frame reports `undefined` once the last scene has finished; the tests that read
			// this are all mid-wizard, where a scene is always mounted.
			return wizard.position.scene as (typeof ALL_SETUP_SCENES)[number];
		},
		send(keyData: string) {
			wizard.handleInput(keyData);
		},
		async confirm() {
			wizard.handleInput(CONFIRM);
			// Scene commits persist through a production authority before reporting done, so
			// assertions made straight after a confirm would otherwise race the write.
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

// The wizard paints through the process-wide theme, so it must be initialised before any
// render - exactly as the application does at startup.
beforeAll(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("dark");
});
afterAll(() => {
	resetCapabilitiesCache();
});

const CONFIRM = "\r";
const DOWN = "\x1b[B";

describe("scene list", () => {
	it("declares the reference's five scenes in order", () => {
		expect(ALL_SETUP_SCENES.map((scene) => scene.id)).toEqual([
			"providers",
			"model",
			"glyph-mode",
			"composer-shape",
			"theme",
		]);
	});

	it("keeps CURRENT_SETUP_VERSION equal to the highest scene version", () => {
		const highest = Math.max(...ALL_SETUP_SCENES.map((scene) => scene.minVersion));
		expect(CURRENT_SETUP_VERSION).toBe(highest);
	});

	it("gives every scene a title", () => {
		for (const scene of ALL_SETUP_SCENES) expect(scene.title.length).toBeGreaterThan(0);
	});
});

describe("wizard sequencing", () => {
	it("walks all five scenes in order", async () => {
		const harness = await mountAll(makeHost());
		const seen = [harness.scene.id];
		for (let i = 0; i < 4; i++) {
			await harness.confirm();
			seen.push(harness.scene.id);
		}
		expect(seen).toEqual(["providers", "model", "glyph-mode", "composer-shape", "theme"]);
	});

	it("records completion only after the last scene", async () => {
		const markComplete = vi.fn(async () => {});
		const host = makeHost({ markComplete });
		const harness = await mountAll(host);
		for (let i = 0; i < 4; i++) {
			await harness.confirm();
			expect(markComplete).not.toHaveBeenCalled();
		}
		await harness.confirm();
		expect(markComplete).toHaveBeenCalledTimes(1);
	});
});

describe("scene persistence through production authorities", () => {
	it("model scene persists the selected model, not the highlighted row", async () => {
		const selectModel = vi.fn(async (_model: Model<string>, _selector: string) => {});
		const host = makeHost({ selectModel });
		const harness = await mountAll(host);
		await harness.confirm(); // leave providers
		harness.send(DOWN); // index 0 -> index 1
		harness.send(CONFIRM);
		await new Promise((resolve) => setImmediate(resolve));
		expect(selectModel).toHaveBeenCalledTimes(1);
		const [chosen, selector] = selectModel.mock.calls[0];
		// The persisted value is a stable provider/model id, never a display label.
		expect(selector).toBe("anthropic/claude");
		expect(chosen.id).toBe("claude");
	});

	it("glyph scene previews without persisting, and persists on confirm", async () => {
		const saveSymbolPreset = vi.fn(async (_preset: SymbolPreset) => {});
		const host = makeHost({ saveSymbolPreset });
		const harness = await mountAll(host);
		await harness.confirm(); // providers
		await harness.confirm(); // model
		harness.send(DOWN);
		harness.send(DOWN); // ascii
		harness.send(CONFIRM);
		await new Promise((resolve) => setImmediate(resolve));
		expect(saveSymbolPreset).toHaveBeenCalled();
		expect(saveSymbolPreset.mock.calls.at(-1)?.[0]).toBe("ascii");
	});

	it("composer scene persists the shape on confirm", async () => {
		const saveComposerShape = vi.fn(async (_shape: ComposerShape) => {});
		const host = makeHost({ saveComposerShape });
		const harness = await mountAll(host);
		for (let i = 0; i < 3; i++) await harness.confirm();
		harness.send(CONFIRM);
		await new Promise((resolve) => setImmediate(resolve));
		expect(saveComposerShape).toHaveBeenCalledTimes(1);
	});

	it("theme scene previews arrowing without writing, then writes once on confirm", async () => {
		const saveTheme = vi.fn(async (_mode: TerminalTheme, _name: string) => {});
		setThemePreviewHook(() => {});
		const host = makeHost({ saveTheme, detectedAppearance: "dark" });
		const harness = await mountAll(host);
		for (let i = 0; i < 4; i++) await harness.confirm();
		// Browsing must not leave every previewed theme behind.
		harness.send(DOWN);
		harness.send(DOWN);
		expect(saveTheme).not.toHaveBeenCalled();
		harness.send(CONFIRM);
		await new Promise((resolve) => setImmediate(resolve));
		expect(saveTheme).toHaveBeenCalledTimes(1);
		const [mode, name] = saveTheme.mock.calls[0];
		expect(mode).toBe("dark");
		expect(host.availableThemes).toContain(name);
	});

	it("writes the theme to the slot matching the detected appearance", async () => {
		const saveTheme = vi.fn(async (_mode: TerminalTheme, _name: string) => {});
		const host = makeHost({ saveTheme, detectedAppearance: "light" });
		const harness = await mountAll(host);
		for (let i = 0; i < 4; i++) await harness.confirm();
		harness.send(CONFIRM);
		const [mode] = saveTheme.mock.calls[0];
		expect(mode).toBe("light");
	});
});

describe("theme preview isolation", () => {
	it("does not persist anything while browsing", async () => {
		// Guard against the preview hook being wired to a write: it must be a display-only path.
		const saveTheme = vi.fn(async (_mode: TerminalTheme, _name: string) => {});
		const host = makeHost({ saveTheme });
		const harness = await mountAll(host);
		for (let i = 0; i < 4; i++) await harness.confirm();
		for (let i = 0; i < 3; i++) harness.send(DOWN);
		expect(saveTheme).not.toHaveBeenCalled();
	});
});

describe("wizard frame", () => {
	function frame(scenes = ALL_SETUP_SCENES, rows = 40, columns = 100) {
		const onComplete = vi.fn();
		const onCancel = vi.fn();
		const requestRender = vi.fn();
		const wizard = new SetupWizard({
			ctx: makeHost(),
			scenes,
			terminalRows: rows,
			terminalColumns: columns,
			onComplete,
			onCancel,
			requestRender,
		});
		return { wizard, onComplete, onCancel, requestRender };
	}

	it("shows a notice instead of the wizard on a too-short terminal", () => {
		// Better than rendering a frame the user cannot use, and better than blocking input on
		// a wizard they cannot see.
		const { wizard } = frame(ALL_SETUP_SCENES, 6);
		const lines = wizard.render();
		expect(lines.join("\n")).toContain("Resize");
	});

	it("never renders more rows than the terminal has", () => {
		for (const rows of [12, 16, 24, 40, 60]) {
			const { wizard } = frame(ALL_SETUP_SCENES, rows);
			expect(wizard.render().length, `at ${rows} rows`).toBeLessThanOrEqual(rows);
		}
	});

	it("drops chrome on a short terminal to keep the body usable", () => {
		const tall = frame(ALL_SETUP_SCENES, 40).wizard.render();
		const short = frame(ALL_SETUP_SCENES, 16).wizard.render();
		// The progress hint is frame chrome, and it is the only thing that carries the scene
		// counter - so its presence, not the word "continue", is what distinguishes the modes:
		// the providers scene body mentions continuing on its own.
		expect(tall.join("\n")).toContain(`1 of ${ALL_SETUP_SCENES.length}`);
		expect(short.join("\n")).not.toContain(`of ${ALL_SETUP_SCENES.length}`);
		expect(short.length).toBeGreaterThan(0);
		// The scene body must survive, or a short terminal would show an empty wizard.
		expect(short.join("\n")).toContain(ALL_SETUP_SCENES[0].title);
	});

	it("shows scene progress in the hint row", () => {
		const { wizard } = frame();
		expect(wizard.render().join("\n")).toContain(`1 of ${ALL_SETUP_SCENES.length}`);
	});

	it("completes when the last scene finishes", async () => {
		const { wizard, onComplete } = frame();
		// Scene commits persist before reporting done, so each confirm must be allowed to
		// settle before the next is sent - otherwise the sequence collapses.
		for (let i = 0; i < 5; i++) {
			wizard.handleInput(CONFIRM);
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("records nothing when the user exits mid-wizard", () => {
		const { wizard, onComplete, onCancel } = frame();
		wizard.handleInput(CONFIRM); // providers -> model
		wizard.handleInput("\x03"); // ctrl+c
		expect(onCancel).toHaveBeenCalledTimes(1);
		// The whole of recovery: completion is never written, so the next launch resumes.
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("does not complete after the user has exited", () => {
		const { wizard, onComplete } = frame();
		wizard.handleInput("\x03");
		wizard.handleInput(CONFIRM);
		wizard.handleInput(CONFIRM);
		expect(onComplete).not.toHaveBeenCalled();
	});
});
