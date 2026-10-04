import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { renderSetupSplash, SETUP_SPLASH_MS, SETUP_TICK_MS } from "../modes/interactive/startup-splash.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

/**
 * Whether this is the Prime Pi distribution rather than a rebranded third-party build.
 *
 * The test is on the **package name and config directory**, never on the display name.
 * It used to compare `appName === "pi"`, which meant renaming the product silently
 * disabled the first-time setup experience — the gate that decides whether the startup
 * splash appears at all. A product's own name is not evidence about its provenance; the
 * npm scope it ships under and the directory it reads are.
 *
 * `appName` stays in the metadata shape because callers pass it, but is deliberately not
 * compared: any display name is legitimate for an official build.
 */
function isOfficialDistribution({ packageName, configDirName }: DistributionMetadata): boolean {
	return packageName === OFFICIAL_PACKAGE_NAME && configDirName === OFFICIAL_CONFIG_DIR_NAME;
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager);
}

async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Show the animated startup splash on the real launch path.
 *
 * Runs on the same primitives the other startup surfaces use - `createStartupTui` paints a
 * throwaway TUI and `clearStartupTui` takes it down - so it needs no new wiring and cannot
 * leave the terminal in a state the next screen cannot recover from.
 *
 * Gated as the reference gates it: interactive mode only, never while resuming or piping, and
 * suppressed by `PI_SKIP_STARTUP_SPLASH` for scripted and benchmark runs. The reference's
 * own default is **off**; here it is on, because the brief asks for the startup experience
 * to be visible, and the escape hatch is one environment variable.
 *
 * Returns after `SETUP_SPLASH_MS`, or immediately when the terminal is too small for the
 * full scene, so a narrow window costs nothing.
 */
export async function showStartupSplash(settingsManager: SettingsManager): Promise<void> {
	if (process.env.PI_SKIP_STARTUP_SPLASH) return;
	const ui = await createStartupTui(settingsManager);
	const startedAt = Date.now();
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (): Promise<void> => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};
		const paint = (): void => {
			const elapsed = Date.now() - startedAt;
			ui.clear();
			for (const line of renderSetupSplash(ui.terminal.columns, ui.terminal.rows, elapsed)) {
				ui.addChild(new Text(line));
			}
			ui.requestRender();
			if (elapsed >= SETUP_SPLASH_MS) void finish();
		};
		paint();
		const timer = setInterval(paint, SETUP_TICK_MS);
		// Deliberately **not** unref'd. `unref` lets the event loop exit while the splash is
		// still on screen, so a short-lived invocation can terminate before `finish` runs and the
		// splash never clears - it is left painted with no interactive mode behind it. The
		// timer is cleared by `finish`, so it cannot outlive the splash either way.
	});
}

/**
 * Whether an environment variable opts in.
 *
 * Deliberately permissive about spelling, because a user who sets a skip flag should not be
 * surprised by which word they typed: `1`, `true`, `yes` and `on` all mean yes, and `0`,
 * `false`, `no`, and the empty string all mean no. This mirrors the reference's own
 * `setupSkipEnvEnabled`, which uses the same rule, so a user carrying a habit from the
 * reference is not caught out.
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Prime Pi distribution (not a third-party fork)
 * - the setup was not skipped (PI_SKIP_SETUP, matching the reference's OMP_SKIP_SETUP)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 *
 * The `PI_EXPERIMENTAL` gate this used to carry was wrong on two counts. It put the
 * product's default first-run experience behind a flag nobody sets, and the reference does
 * not gate it that way at all: it offers `OMP_SKIP_SETUP` instead, i.e. on by default with
 * an opt-out. The name keeps the established `PI_` prefix so it reads as a
 * compatibility-consistent variable rather than a new convention.
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (isTruthyEnvFlag(process.env.PI_SKIP_SETUP)) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
