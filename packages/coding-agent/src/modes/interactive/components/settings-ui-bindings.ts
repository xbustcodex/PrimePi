/**
 * Picker row bindings: the single declaration point for the settings UI.
 *
 * The registry (`settings-registry.ts`) owns each setting's schema — type, default,
 * permitted values, label, description. This module owns the three things a schema
 * cannot express about a control:
 *
 *  - **display order**, which the picker previously built with positional `splice`
 *    calls interleaved with the base array;
 *  - **capability conditions**, currently the two image rows that only appear when
 *    the terminal reports image support;
 *  - **the typed write**, because each control calls a specific
 *    `SettingsCallbacks` member that also performs UI side effects.
 *
 * Bespoke controls (theme, warnings, per-model thinking, HTTP idle timeout, project
 * trust) keep their custom components; they are declared here too so the inventory
 * stays in one place, with `submenu` supplied by the caller.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	CacheWarmingMode,
	DefaultProjectTrust,
	FullscreenExitOutput,
	TuiMode,
} from "../../../core/settings-manager.ts";
import { lookupSetting } from "../../../core/settings-registry.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import type { SettingsCallbacks, SettingsConfig } from "./settings-selector.ts";

export interface SettingRowBinding {
	/** Row id, matching the existing picker ids so tests and submenus keep working. */
	id: string;
	/** Registry key for this control. */
	key: string;
	/** Only present when the terminal reports image support. */
	requiresImages?: boolean;
	/** Values cycled with Enter/Space, when the control is an inline cycle. */
	values?: readonly string[];
	/** Current value rendered on the right of the row. */
	currentValue(config: SettingsConfig): string;
	/**
	 * Overrides the descriptor description when it is dynamic, for example when it
	 * interpolates a keybinding hint.
	 */
	description?(config: SettingsConfig): string | undefined;
	/** Applies a new row value. Only called for inline cycle controls. */
	apply?(config: SettingsConfig, raw: string, callbacks: SettingsCallbacks): void;
	/** True when the picker must supply a custom submenu component for this row. */
	custom?: boolean;
}

const bool = (value: boolean): string => (value ? "true" : "false");

/** Human labels for the project-trust enum, matching the labels the picker showed. */
const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([label, value]) => [label, value as DefaultProjectTrust]),
);

/**
 * Display order, matching the picker exactly as it was before the registry:
 * auto-compact, the image block, skill/cursor/padding toggles, then the rest.
 */
export const SETTINGS_ROW_BINDINGS: readonly SettingRowBinding[] = [
	{
		id: "autocompact",
		key: "compaction.enabled",
		values: ["true", "false"],
		currentValue: (c) => bool(c.autoCompact),
		apply: (_c, raw, cb) => cb.onAutoCompactChange(raw === "true"),
	},
	{
		id: "show-images",
		key: "terminal.showImages",
		requiresImages: true,
		values: ["true", "false"],
		currentValue: (c) => bool(c.showImages),
		apply: (_c, raw, cb) => cb.onShowImagesChange(raw === "true"),
	},
	{
		id: "image-width-cells",
		key: "terminal.imageWidthCells",
		requiresImages: true,
		values: ["60", "80", "120"],
		currentValue: (c) => String(c.imageWidthCells),
		apply: (_c, raw, cb) => cb.onImageWidthCellsChange(Number.parseInt(raw, 10)),
	},
	{
		id: "auto-resize-images",
		key: "images.autoResize",
		values: ["true", "false"],
		currentValue: (c) => bool(c.autoResizeImages),
		apply: (_c, raw, cb) => cb.onAutoResizeImagesChange(raw === "true"),
	},
	{
		id: "block-images",
		key: "images.blockImages",
		values: ["true", "false"],
		currentValue: (c) => bool(c.blockImages),
		apply: (_c, raw, cb) => cb.onBlockImagesChange(raw === "true"),
	},
	{
		id: "skill-commands",
		key: "enableSkillCommands",
		values: ["true", "false"],
		currentValue: (c) => bool(c.enableSkillCommands),
		apply: (_c, raw, cb) => cb.onEnableSkillCommandsChange(raw === "true"),
	},
	{
		id: "show-hardware-cursor",
		key: "showHardwareCursor",
		values: ["true", "false"],
		currentValue: (c) => bool(c.showHardwareCursor),
		apply: (_c, raw, cb) => cb.onShowHardwareCursorChange(raw === "true"),
	},
	{
		id: "editor-padding",
		key: "editorPaddingX",
		values: ["0", "1", "2", "3"],
		currentValue: (c) => String(c.editorPaddingX),
		apply: (_c, raw, cb) => cb.onEditorPaddingXChange(Number.parseInt(raw, 10)),
	},
	{
		id: "output-padding",
		key: "outputPad",
		values: ["0", "1"],
		currentValue: (c) => String(c.outputPad),
		apply: (_c, raw, cb) => cb.onOutputPadChange(raw === "0" ? 0 : 1),
	},
	{
		id: "autocomplete-max-visible",
		key: "autocompleteMaxVisible",
		values: ["3", "5", "7", "10", "15", "20"],
		currentValue: (c) => String(c.autocompleteMaxVisible),
		apply: (_c, raw, cb) => cb.onAutocompleteMaxVisibleChange(Number.parseInt(raw, 10)),
	},
	{
		id: "clear-on-shrink",
		key: "terminal.clearOnShrink",
		values: ["true", "false"],
		currentValue: (c) => bool(c.clearOnShrink),
		apply: (_c, raw, cb) => cb.onClearOnShrinkChange(raw === "true"),
	},
	{
		id: "terminal-progress",
		key: "terminal.showTerminalProgress",
		values: ["true", "false"],
		currentValue: (c) => bool(c.showTerminalProgress),
		apply: (_c, raw, cb) => cb.onShowTerminalProgressChange(raw === "true"),
	},
	{
		id: "steering-mode",
		key: "steeringMode",
		values: ["one-at-a-time", "all"],
		currentValue: (c) => c.steeringMode,
		apply: (_c, raw, cb) => cb.onSteeringModeChange(raw as "all" | "one-at-a-time"),
	},
	{
		id: "follow-up-mode",
		key: "followUpMode",
		values: ["one-at-a-time", "all"],
		// The hint names the actual key, which is resolved at render time.
		description: () =>
			`${keyDisplayText("app.message.followUp")} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
		currentValue: (c) => c.followUpMode,
		apply: (_c, raw, cb) => cb.onFollowUpModeChange(raw as "all" | "one-at-a-time"),
	},
	{
		id: "transport",
		key: "transport",
		values: ["sse", "websocket", "websocket-cached", "auto"],
		currentValue: (c) => c.transport as Transport,
		apply: (_c, raw, cb) => cb.onTransportChange(raw as Transport),
	},
	{
		id: "http-idle-timeout",
		key: "httpIdleTimeoutMs",
		values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
		currentValue: (c) => formatHttpIdleTimeoutMs(c.httpIdleTimeoutMs),
		apply: (_c, raw, cb) => {
			const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === raw);
			if (choice) cb.onHttpIdleTimeoutMsChange(choice.timeoutMs);
		},
	},
	{
		id: "cache-warming-mode",
		key: "cacheWarming",
		values: ["off", "streaming", "idle"],
		currentValue: (c) => c.cacheWarmingMode as CacheWarmingMode,
		apply: (_c, raw, cb) => cb.onCacheWarmingModeChange(raw as CacheWarmingMode),
	},
	{
		id: "hide-thinking",
		key: "hideThinkingBlock",
		values: ["true", "false"],
		currentValue: (c) => bool(c.hideThinkingBlock),
		apply: (_c, raw, cb) => cb.onHideThinkingBlockChange(raw === "true"),
	},
	{
		id: "mermaid-rendering",
		key: "markdown.mermaid",
		values: ["off", "final", "streaming"],
		currentValue: (c) => c.mermaidRenderingMode,
		apply: (_c, raw, cb) => cb.onMermaidRenderingModeChange(raw as "off" | "final" | "streaming"),
	},
	{
		id: "cache-miss-notices",
		key: "showCacheMissNotices",
		values: ["true", "false"],
		currentValue: (c) => bool(c.showCacheMissNotices),
		apply: (_c, raw, cb) => cb.onShowCacheMissNoticesChange(raw === "true"),
	},
	{
		id: "collapse-changelog",
		key: "collapseChangelog",
		values: ["true", "false"],
		currentValue: (c) => bool(c.collapseChangelog),
		apply: (_c, raw, cb) => cb.onCollapseChangelogChange(raw === "true"),
	},
	{
		id: "quiet-startup",
		key: "quietStartup",
		values: ["true", "false"],
		currentValue: (c) => bool(c.quietStartup),
		apply: (_c, raw, cb) => cb.onQuietStartupChange(raw === "true"),
	},
	{
		id: "install-telemetry",
		key: "enableInstallTelemetry",
		values: ["true", "false"],
		currentValue: (c) => bool(c.enableInstallTelemetry),
		apply: (_c, raw, cb) => cb.onEnableInstallTelemetryChange(raw === "true"),
	},
	{
		id: "default-project-trust",
		key: "defaultProjectTrust",
		// Rendered by its human labels rather than its stored enum values.
		values: ["Ask", "Always trust", "Never trust"],
		currentValue: (c) => DEFAULT_PROJECT_TRUST_LABELS[c.defaultProjectTrust as DefaultProjectTrust],
		apply: (_c, raw, cb) => {
			for (const [label, value] of DEFAULT_PROJECT_TRUST_BY_LABEL) {
				if (label === raw) cb.onDefaultProjectTrustChange(value);
			}
		},
	},
	{
		id: "double-escape-action",
		key: "doubleEscapeAction",
		values: ["tree", "fork", "none"],
		currentValue: (c) => c.doubleEscapeAction,
		apply: (_c, raw, cb) => cb.onDoubleEscapeActionChange(raw as "fork" | "tree" | "none"),
	},
	{
		id: "tree-filter-mode",
		key: "treeFilterMode",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"],
		currentValue: (c) => c.treeFilterMode,
		apply: (_c, raw, cb) =>
			cb.onTreeFilterModeChange(raw as "default" | "no-tools" | "user-only" | "labeled-only" | "all"),
	},
	{ id: "warnings", key: "warnings", currentValue: () => "", custom: true },
	{ id: "model-thinking", key: "modelThinkingLevels", currentValue: () => "", custom: true },
	{
		id: "tui-mode",
		key: "tuiMode",
		values: ["regular", "fullscreen"],
		currentValue: (c) => c.tuiMode as TuiMode,
		apply: (_c, raw, cb) => cb.onTuiModeChange(raw as TuiMode),
	},
	{
		id: "fullscreen-exit-output",
		key: "fullscreenExitOutput",
		values: ["transcript", "resume-hint"],
		currentValue: (c) => c.fullscreenExitOutput as FullscreenExitOutput,
		apply: (_c, raw, cb) => cb.onFullscreenExitOutputChange(raw as FullscreenExitOutput),
	},
	{
		id: "fullscreen-scrollbar",
		key: "fullscreenScrollbar",
		values: ["auto", "always", "hidden"],
		currentValue: (c) => c.fullscreenScrollbar as ScrollViewScrollbar,
		apply: (_c, raw, cb) => cb.onFullscreenScrollbarChange(raw as ScrollViewScrollbar),
	},
	{
		id: "fullscreen-copy-on-select",
		key: "fullscreenCopyOnSelect",
		values: ["true", "false"],
		currentValue: (c) => bool(c.fullscreenCopyOnSelect),
		apply: (_c, raw, cb) => cb.onFullscreenCopyOnSelectChange(raw === "true"),
	},
	{ id: "theme", key: "theme", currentValue: (c) => c.currentTheme, custom: true },
	// `warnings.anthropicExtraUsage` is declared in the registry but is not a row
	// here: it is rendered inside the warnings submenu, which commits the whole
	// WarningSettings object through onWarningsChange rather than a per-setting
	// callback.
];

const bindingById = new Map(SETTINGS_ROW_BINDINGS.map((binding) => [binding.id, binding]));

export function rowBinding(id: string): SettingRowBinding | undefined {
	return bindingById.get(id);
}

/** Rows visible for the given terminal capability, in display order. */
export function visibleRowBindings(supportsImages: boolean): readonly SettingRowBinding[] {
	return SETTINGS_ROW_BINDINGS.filter((binding) => !binding.requiresImages || supportsImages);
}

/** Row ids that the picker must render with a custom submenu component. */
export function customRowIds(): readonly string[] {
	return SETTINGS_ROW_BINDINGS.filter((binding) => binding.custom).map((binding) => binding.id);
}

/**
 * Fails loudly when a row binding names a setting that was never declared, so a
 * binding cannot drift away from the registry.
 */
export function assertBindingsMatchRegistry(): void {
	for (const binding of SETTINGS_ROW_BINDINGS) {
		if (!lookupSetting(binding.key)) {
			throw new Error(`Settings row "${binding.id}" references unregistered setting "${binding.key}"`);
		}
	}
}

/** Thinking levels referenced by the custom per-model submenu, kept typed. */
export type { ThinkingLevel };
