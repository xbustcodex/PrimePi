/**
 * Onboarding scene contract and scene selection.
 *
 * Ported from the reference's `packages/tui/src/setup/`, with the product surface renamed and
 * the application preferences re-pointed at Prime Pi's own settings authority. Two things are
 * deliberately *not* carried over unchanged, and both are called out where they occur.
 *
 * Selection is version-gated rather than presence-gated. A user who abandons onboarding part
 * way through still has a settings file, so "does settings.json exist" cannot stand in for
 * "has onboarding finished" - it would strand them mid-wizard with no way back in.
 */

import type { Model } from "../../../../ai/src/types.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

/**
 * Setup version a fresh install is advanced to.
 *
 * MUST equal `max(scene.minVersion)` across `ALL_SCENES`. Bump it whenever a scene is added
 * or an existing scene raises its `minVersion`, so an already-onboarded user sees only the new
 * work rather than the whole wizard again.
 */
export const CURRENT_SETUP_VERSION = 2;

/** Outcome a scene reports when it finishes. */
export type SetupSceneResult = "done" | "skipped";

/** Symbol glyphs the UI may draw. Mirrors the reference's preset vocabulary. */
export type SymbolPreset = "default" | "minimal" | "ascii" | "nerd";

/** The composer frame shapes offered during onboarding. */
export type ComposerShape = "band" | "rounded" | "minimal" | "underline";

/** Terminal appearance the user can be steered toward. */
export type TerminalTheme = "dark" | "light";

/**
 * A model as the onboarding model scene sees it.
 *
 * Wraps the platform model with the reason it is offered, so the scene can show *why* a model
 * is available rather than presenting an undifferentiated list. `access` comes from the model
 * access authority; the scene never decides eligibility itself.
 */
export interface OnboardingModel {
	readonly model: Model<string>;
	/** `credential-free`, `authenticated`, or `unavailable`, as classified by the registry. */
	readonly access: "credential-free" | "authenticated";
	/** True when this is the session's current model. */
	readonly current: boolean;
}

/**
 * Application-owned preferences and effects consumed by onboarding scenes.
 *
 * Every method here is a *production* authority, not a wizard-local buffer: a choice made in
 * onboarding lands in the same store the running application reads afterwards. There is
 * deliberately no wizard-scoped state, so nothing can be chosen in onboarding and then
 * silently diverge from what the product actually uses.
 */
export interface SetupHost {
	/** How far onboarding has progressed. Read live, so a re-run resumes rather than restarts. */
	readonly setupVersion: number;
	/** The terminal appearance already configured. */
	readonly configuredDarkTheme: string | undefined;
	readonly configuredLightTheme: string | undefined;
	/** The appearance the terminal reports, used to preselect and to preview. */
	readonly detectedAppearance: TerminalTheme;
	readonly symbolPreset: SymbolPreset;
	readonly composerShape: ComposerShape;
	readonly colorBlindMode: boolean;
	/** Providers the user has explicitly disabled. */
	readonly disabledProviders: readonly string[];
	/** Every theme that can be previewed, in display order. */
	readonly availableThemes: readonly string[];

	/** Providers with usable credentials, in display order. */
	authenticatedProviders(): readonly string[];
	/** All known providers, whether authenticated or not. */
	allProviders(): readonly string[];

	/** Models the registry considers available, already filtered by the access authority. */
	getModels(): OnboardingModel[];
	/** Re-check model availability against the registry. */
	refreshModels(): Promise<void>;
	/**
	 * Persist a default-model choice through the same path the runtime uses.
	 *
	 * `selector` is the stable provider/model id, not a display label, so the persisted value
	 * cannot depend on how a model happened to be named on screen.
	 */
	selectModel(model: Model<string>, selector: string): Promise<void>;

	saveComposerShape(shape: ComposerShape): Promise<void>;
	saveSymbolPreset(preset: SymbolPreset): Promise<void>;
	saveColorBlindMode(enabled: boolean): void;
	saveTheme(mode: TerminalTheme, name: string): Promise<void>;

	/** Record onboarding completion. Called once, after the last scene, not per scene. */
	markComplete(version: number): Promise<void>;
	/** Surface a non-fatal problem without tearing down the wizard. */
	showError(message: string): void;

	readonly settings: SettingsManager;
}

/** Per-scene focus, rendering, and completion callbacks. */
export interface SetupSceneHost {
	ctx: SetupHost;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
}

/**
 * Interactive content for one scene.
 *
 * `render` receives the number of body rows the wizard will actually display, so a scene can
 * shrink its own list window rather than being clipped mid-row. Overflow is still clipped by
 * the frame; the budget is advisory to the scene, authoritative for the frame.
 */
export interface SetupSceneController {
	/** Rows the frame will render above and below this body, in addition to the body itself. */
	readonly chromeRows?: number;
	render(width: number, maxLines: number): readonly string[];
	/** Handle a key press. Scenes own their own navigation. */
	handleInput(keyData: string): void;
	/** Release timers and subscriptions when the scene is unmounted. */
	dispose?(): void;
}

/** A versioned onboarding scene. */
export interface SetupScene {
	readonly id: string;
	readonly title: string;
	/** Scenes with `minVersion <= storedVersion` have already been seen and are skipped. */
	readonly minVersion: number;
	/**
	 * Whether this scene applies at all to the current configuration.
	 *
	 * Checked against live state, not the stored version: a user who already has an API key
	 * should not be asked to sign in again, but should still be shown the scenes they have not
	 * completed.
	 */
	shouldRun?(ctx: SetupHost): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}

/** Environment and invocation gates for onboarding selection. */
export interface SetupSceneSelectionOptions {
	/** Resuming a prior session: onboarding must not reopen over restored transcript. */
	resuming?: boolean;
	isTTY?: boolean;
	/** Set to force the wizard regardless of version or environment gates. */
	force?: boolean;
	/** Explicit opt-out, from the settings panel. */
	setupWizardEnabled?: boolean;
}

/**
 * Whether a skip variable is set.
 *
 * Mirrors the reference's rule: anything other than empty, `0`, `false` or `no` means skip.
 * A user who typed a skip flag should not be caught out by which word they chose.
 */
export function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Select the scenes a launch should run.
 *
 * Order is the caller's `scenes` order, so the scene list is the single source of ordering
 * truth rather than being duplicated here.
 */
export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx: SetupHost | undefined,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
	// A non-TTY launch has no keyboard, so an interactive wizard would hang forever. This is
	// a hard gate, not one `force` can override: there is no way to answer a prompt here.
	if (!isTTY) return [];
	if (!options.force) {
		if (options.resuming) return [];
		if (setupSkipEnvEnabled(process.env.PI_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
	}

	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion <= storedVersion) continue;
		// A `shouldRun` needs live state, so it cannot be honoured without a host. Rather than
		// run a scene whose applicability is unknown, skip it and let the version gate carry the
		// user forward.
		if (scene.shouldRun) {
			if (!ctx) continue;
			if (!(await scene.shouldRun(ctx))) continue;
		}
		selected.push(scene);
	}
	return selected;
}
