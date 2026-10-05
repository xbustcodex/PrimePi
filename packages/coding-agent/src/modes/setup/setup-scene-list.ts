/**
 * The five onboarding scenes, in the reference's order.
 *
 *   1. providers - sign in, so anything downstream has credentials to work with
 *   2. model     - pick a default model
 *   3. glyph     - symbol preset, for terminals that cannot draw box drawing
 *   4. composer  - composer shape
 *   5. theme     - theme, previewed live, written to the matching slot
 *
 * Each scene writes through a `SetupHost` production authority, never into wizard-local state,
 * so a choice made here is the choice the running application uses. `minVersion` is what makes
 * a release able to add a scene without re-onboarding an existing user, and
 * `CURRENT_SETUP_VERSION` must stay equal to the highest one here.
 */

import { getKeybindings } from "@earendil-works/pi-tui";
import { theme } from "../interactive/theme/theme.ts";
import {
	type ComposerShape,
	CURRENT_SETUP_VERSION,
	type SetupHost,
	type SetupScene,
	type SetupSceneController,
	type SetupSceneHost,
	type SymbolPreset,
	type TerminalTheme,
} from "./setup-scenes.ts";
import { ChoiceScene, NoticeScene } from "./setup-wizard.ts";

// --- Scene 1: providers ---------------------------------------------------

/**
 * Credential sign-in.
 *
 * Presented as a checklist rather than a login form: the reference does the same, because the
 * useful question on a fresh install is "what do I have", not "what is your API key". A user
 * with no key can pass straight through - the model scene will show them what they can reach
 * without one, and credential-free models are exactly that case.
 */
export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Providers and credentials",
	minVersion: 1,
	mount: (host) => new ProvidersScene(host),
};

const PROVIDER_HINTS: Record<string, string> = {
	anthropic: "Claude, on an API key or a subscription",
	openai: "GPT models, on an API key",
	google: "Gemini models, on an API key",
	openrouter: "Many providers behind one key",
};

class ProvidersScene implements SetupSceneController {
	readonly #host: SetupSceneHost;
	#index = 0;
	#providers: string[] = [];
	#authenticated: string[] = [];
	#loaded = false;

	constructor(host: SetupSceneHost) {
		this.#host = host;
	}

	/**
	 * Fetch the provider list once, on first use.
	 *
	 * On render *and* on input: the frame can deliver a key press before the first paint, and a
	 * list loaded only at render time would read as empty and silently skip.
	 */
	#ensureProviders(): void {
		if (this.#loaded) return;
		this.#providers = [...this.#host.ctx.allProviders()];
		this.#authenticated = [...this.#host.ctx.authenticatedProviders()];
		this.#loaded = true;
	}

	render(width: number, maxLines: number): readonly string[] {
		this.#ensureProviders();
		if (this.#providers.length === 0) {
			return [
				theme.fg("muted", "No providers available yet.").slice(0, width),
				theme.fg("text", "Credential-free models still work without signing in.").slice(0, width),
			];
		}
		const out: string[] = [theme.fg("text", "Sign in with /login later, or continue without.").slice(0, width)];
		const rows = Math.max(1, maxLines - 1);
		// Window the list so the selection stays visible on a short terminal.
		const start = Math.max(0, Math.min(this.#index - Math.floor(rows / 2), this.#providers.length - rows));
		const end = Math.min(this.#providers.length, Math.max(start + rows, start + 1));
		for (let i = Math.max(0, start); i < end; i++) {
			const provider = this.#providers[i];
			const signedIn = this.#authenticated.includes(provider);
			const mark = signedIn ? theme.fg("success", "✓") : theme.fg("muted", " ");
			const pointer = i === this.#index ? theme.fg("accent", "→ ") : "  ";
			const label = i === this.#index ? theme.fg("accent", provider) : theme.fg("text", provider);
			const detail = PROVIDER_HINTS[provider] ? theme.fg("muted", `  ${PROVIDER_HINTS[provider]}`) : "";
			out.push(`${pointer}${mark} ${label}${detail}`.slice(0, width));
		}
		if (this.#index < this.#providers.length) {
			out.push(theme.fg("muted", "  Run /login <provider> to add a key.").slice(0, width));
		}
		return out;
	}

	handleInput(keyData: string): void {
		this.#ensureProviders();
		const kb = getKeybindings();
		if (this.#providers.length > 0 && (kb.matches(keyData, "tui.select.up") || keyData === "k")) {
			this.#index = Math.max(0, this.#index - 1);
		} else if (this.#providers.length > 0 && (kb.matches(keyData, "tui.select.down") || keyData === "j")) {
			this.#index = Math.min(this.#providers.length - 1, this.#index + 1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			this.#host.finish("done");
		}
	}
}

// --- Scene 2: default model ----------------------------------------------

/**
 * Default model choice.
 *
 * Every option is a model the registry already considers *available* - this scene never decides
 * eligibility, so it cannot offer something the model access authority would refuse. Models
 * reachable without a credential are labelled as such, because that is the case a new user is
 * most likely in and it is not otherwise obvious.
 */
export const modelSetupScene: SetupScene = {
	id: "model",
	title: "Choose your default model",
	minVersion: 1,
	mount: (host) => new ModelScene(host),
};

class ModelScene implements SetupSceneController {
	readonly #host: SetupSceneHost;
	#index = 0;
	#models: ReturnType<SetupHost["getModels"]> = [];
	#loaded = false;

	constructor(host: SetupSceneHost) {
		this.#host = host;
	}

	/**
	 * Fetch the model list once, on first use.
	 *
	 * Deliberately *not* only in `render`: the frame can deliver a key press before the first
	 * paint - a very fast confirm, or a terminal that never calls render - and a scene that
	 * loaded its list at render time would then see an empty list and commit nothing while
	 * appearing to advance. Loading on either path makes the two orderings equivalent.
	 */
	#ensureModels(): void {
		if (this.#loaded) return;
		this.#models = this.#host.ctx.getModels();
		this.#loaded = true;
	}

	render(width: number, maxLines: number): readonly string[] {
		this.#ensureModels();
		if (this.#models.length === 0) {
			return [
				theme.fg("muted", "No models available.").slice(0, width),
				theme.fg("text", "Sign in to a provider, or pick a model later with /model.").slice(0, width),
			];
		}
		const out: string[] = [];
		const rows = Math.max(1, maxLines - 2);
		const start = Math.max(0, Math.min(this.#index - Math.floor(rows / 2), this.#models.length - rows));
		const end = Math.min(this.#models.length, Math.max(start + rows, start + 1));
		for (let i = Math.max(0, start); i < end; i++) {
			const entry = this.#models[i];
			const pointer = i === this.#index ? theme.fg("accent", "→ ") : "  ";
			const name = i === this.#index ? theme.fg("accent", entry.model.id) : theme.fg("text", entry.model.id);
			const tags: string[] = [entry.model.provider];
			// Credential-free is the distinction that matters to a user without a key, so it is
			// called out rather than left to be inferred from the provider name.
			if (entry.access === "credential-free") tags.push("no key needed");
			if (entry.current) tags.push("current");
			out.push(`${pointer}${name} ${theme.fg("muted", tags.join(" · "))}`.slice(0, width));
		}
		out.push(theme.fg("muted", "Change it later with /model.").slice(0, width));
		return out;
	}

	handleInput(keyData: string): void {
		this.#ensureModels();
		const kb = getKeybindings();
		if (this.#models.length === 0) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
				this.#host.finish("done");
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.#move(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.#move(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			void this.#commit();
		}
	}

	#move(delta: number): void {
		const next = Math.min(this.#models.length - 1, Math.max(0, this.#index + delta));
		if (next === this.#index) return;
		this.#index = next;
		this.#host.requestRender();
	}

	async #commit(): Promise<void> {
		const entry = this.#models[this.#index];
		if (!entry) {
			this.#host.finish("done");
			return;
		}
		try {
			await this.#host.ctx.selectModel(entry.model, `${entry.model.provider}/${entry.model.id}`);
			this.#host.finish("done");
		} catch (error) {
			this.#host.ctx.showError(error instanceof Error ? error.message : String(error));
			this.#host.requestRender();
		}
	}
}

// --- Scene 3: glyph mode --------------------------------------------------

/**
 * Symbol preset.
 *
 * Gated on the terminal not already speaking a glyph protocol: if the terminal negotiates
 * glyphs itself, asking the user to choose is noise. ASCII is listed first when detection says
 * the terminal cannot be trusted with box drawing, so the safe answer is the default position.
 */
export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose symbol glyphs",
	minVersion: 1,
	// Always applicable. The reference skips this scene when the terminal speaks a glyph
	// protocol, but Prime Pi has no glyph-protocol negotiation to detect, so there is no
	// honest gate to apply - inventing one would skip a scene the user still needs.
	shouldRun: () => true,
	mount: (host) =>
		new ChoiceScene<SymbolPreset>({
			host,
			options: [
				{
					value: "default",
					label: "Unicode (default)",
					detail: "─ │ ╭ ╮  rounded borders and arrows",
					preview: ["╭──────────╮", "│ Prime Pi │", "╰──────────╯"],
				},
				{
					value: "minimal",
					label: "Minimal",
					detail: "┌ ┐ square borders",
					preview: ["┌──────────┐", "│ Prime Pi │", "└──────────┘"],
				},
				{
					value: "ascii",
					label: "ASCII only",
					detail: "- | + for every border",
					preview: ["+----------+", "| Prime Pi |", "+----------+"],
				},
				{ value: "nerd", label: "Nerd font", detail: "Adds Powerline separators", preview: [" Prime Pi "] },
			],
			initial: host.ctx.symbolPreset,
			onPreview: (value) => host.ctx.saveSymbolPreset(value),
			onCommit: (value) => host.ctx.saveSymbolPreset(value),
		}),
};

// --- Scene 4: composer shape ----------------------------------------------

/**
 * Composer shape.
 *
 * `minVersion: 2` because this scene is newer than the original two; a user who finished
 * onboarding at version 1 sees it once and then never again.
 */
export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	minVersion: 2,
	mount: (host) =>
		new ChoiceScene<ComposerShape>({
			host,
			options: [
				{
					value: "rounded",
					label: "Rounded",
					detail: "The default frame",
					preview: ["╭────────────────────────╮", "│ > ask something         │", "╰────────────────────────╯"],
				},
				{ value: "band", label: "Status Band", detail: "Status on its own line" },
				{ value: "underline", label: "Underline", detail: "A single rule under input" },
				{ value: "minimal", label: "Borderless", detail: "No frame at all" },
			],
			initial: host.ctx.composerShape,
			onPreview: (value) => {
				void host.ctx.saveComposerShape(value);
			},
			onCommit: (value) => host.ctx.saveComposerShape(value),
		}),
};

// --- Scene 5: theme -------------------------------------------------------

/**
 * Theme, previewed live and written to the slot matching the terminal's appearance.
 *
 * The preset is `detectedAppearance`, so a dark terminal opens on a dark theme and vice versa
 * rather than making the user hunt for it. Previewing writes nothing: only the confirmed choice
 * is persisted, so browsing through 102 themes does not leave the last previewed one behind.
 */
export const themeSetupScene: SetupScene = {
	id: "theme",
	title: "Pick a theme",
	minVersion: 1,
	mount: (host) => new ThemeScene(host),
};

class ThemeScene implements SetupSceneController {
	readonly #host: SetupSceneHost;
	#index = 0;
	#themes: string[] = [];

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#themes = [...host.ctx.availableThemes];
		const configured =
			host.ctx.detectedAppearance === "dark" ? host.ctx.configuredDarkTheme : host.ctx.configuredLightTheme;
		const found = configured ? this.#themes.indexOf(configured) : -1;
		// Preselect the detected appearance's slot value, falling back to the reference's own
		// defaults so an unconfigured install still lands on a deliberate theme.
		this.#index =
			found >= 0
				? found
				: Math.max(0, this.#themes.indexOf(host.ctx.detectedAppearance === "dark" ? "titanium" : "light"));
	}

	render(width: number, maxLines: number): readonly string[] {
		if (this.#themes.length === 0) {
			return [theme.fg("muted", "No themes found.").slice(0, width)];
		}
		const out: string[] = [
			theme.fg("muted", `Detected system appearance: ${this.#host.ctx.detectedAppearance}`).slice(0, width),
		];
		const rows = Math.max(1, maxLines - 3);
		const start = Math.max(0, Math.min(this.#index - Math.floor(rows / 2), this.#themes.length - rows));
		const end = Math.min(this.#themes.length, Math.max(start + rows, start + 1));
		for (let i = Math.max(0, start); i < end; i++) {
			const name = this.#themes[i];
			const pointer = i === this.#index ? theme.fg("accent", "→ ") : "  ";
			const label = i === this.#index ? theme.fg("accent", name) : theme.fg("text", name);
			out.push(`${pointer}${label}`.slice(0, width));
		}
		out.push(
			theme.fg("muted", `${this.#index + 1} of ${this.#themes.length}. Change later in settings.`).slice(0, width),
		);
		return out;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.#themes.length === 0) {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
				this.#host.finish("done");
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.#move(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.#move(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
			void this.#commit();
		}
	}

	#move(delta: number): void {
		const next = Math.min(this.#themes.length - 1, Math.max(0, this.#index + delta));
		if (next === this.#index) return;
		this.#index = next;
		// Preview only: writing here would persist every theme the user arrows past.
		host_previewTheme(this.#themes[next]);
		this.#host.requestRender();
	}

	async #commit(): Promise<void> {
		const name = this.#themes[this.#index];
		if (!name) {
			this.#host.finish("done");
			return;
		}
		try {
			await this.#host.ctx.saveTheme(this.#host.ctx.detectedAppearance satisfies TerminalTheme, name);
			this.#host.finish("done");
		} catch (error) {
			this.#host.ctx.showError(error instanceof Error ? error.message : String(error));
			this.#host.requestRender();
		}
	}
}

/**
 * Apply a theme for preview without persisting it.
 *
 * Assigned by the composition root so the scene does not import the theme module directly and
 * can be exercised with a stub. Falling back to a no-op means a scene under test never depends
 * on global theme state it does not control.
 */
let host_previewTheme: (name: string) => void = () => {};
export function setThemePreviewHook(hook: (name: string) => void): void {
	host_previewTheme = hook;
}

/** Scenes in the reference's order. */
export const ALL_SETUP_SCENES: readonly SetupScene[] = [
	providersSetupScene,
	modelSetupScene,
	glyphSetupScene,
	composerSetupScene,
	themeSetupScene,
];

export { NoticeScene };

// The highest `minVersion` any scene declares. `CURRENT_SETUP_VERSION` must equal this, or a
// user can complete onboarding without ever having been shown the newest scene.
const highestSceneVersion = ALL_SETUP_SCENES.reduce((max, scene) => Math.max(max, scene.minVersion), 1);
if (highestSceneVersion !== CURRENT_SETUP_VERSION) {
	throw new Error(
		`CURRENT_SETUP_VERSION (${CURRENT_SETUP_VERSION}) must equal max(scene.minVersion) (${highestSceneVersion}). ` +
			`A user who completes onboarding would never be shown the newest scene.`,
	);
}
