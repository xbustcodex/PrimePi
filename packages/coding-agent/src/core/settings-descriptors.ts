/**
 * Declarations for Pi's existing user-facing settings.
 *
 * Phase 1 registers only settings that already exist and are already reachable in
 * the settings UI or the config file. It deliberately adds **no new user-facing
 * setting**: every entry here corresponds to a control or config key that shipped
 * before this registry existed.
 *
 * `order` mirrors the current row order in the settings picker so migrating onto
 * the registry does not reorder the interface.
 */

import { registerSetting } from "./settings-registry.ts";

/**
 * Cache-warming profile. "idle" also warms between agent runs.
 *
 * Declared here rather than in `settings-manager` so this module has no dependency
 * on the store, and the store can depend on it for registration without a cycle.
 * Re-exported from `settings-manager`, which is where callers already import it.
 */
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;

// --- Display and images -------------------------------------------------------

export const showImages = registerSetting({
	key: "terminal.showImages",
	type: "boolean",
	default: true,
	ui: { label: "Show images", description: "Render images inline in terminal", order: 20, control: "cycle" },
});

export const imageWidthCells = registerSetting({
	key: "terminal.imageWidthCells",
	type: "number",
	default: 60,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Image width",
		description: "Preferred inline image width in terminal cells",
		order: 21,
		control: "cycle",
	},
});

export const autoResizeImages = registerSetting({
	key: "images.autoResize",
	type: "boolean",
	default: true,
	ui: {
		label: "Auto-resize images",
		description: "Resize large images to 2000x2000 max for better model compatibility",
		order: 22,
		control: "cycle",
	},
});

export const blockImages = registerSetting({
	key: "images.blockImages",
	type: "boolean",
	default: false,
	ui: {
		label: "Block images",
		description: "Prevent images from being sent to LLM providers",
		order: 23,
		control: "cycle",
	},
});

export const clearOnShrink = registerSetting({
	key: "terminal.clearOnShrink",
	type: "boolean",
	default: false,
	env: "PI_CLEAR_ON_SHRINK",
	parseEnv: (raw) => raw === "1",
	ui: {
		label: "Clear on shrink",
		description: "Clear empty rows when content shrinks (may cause flicker)",
		order: 24,
		control: "cycle",
	},
});

export const showTerminalProgress = registerSetting({
	key: "terminal.showTerminalProgress",
	type: "boolean",
	default: false,
	ui: {
		label: "Terminal progress",
		description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		order: 25,
		control: "cycle",
	},
});

export const showHardwareCursor = registerSetting({
	key: "showHardwareCursor",
	type: "boolean",
	default: true,
	env: "PI_HARDWARE_CURSOR",
	parseEnv: (raw) => raw === "1",
	ui: {
		label: "Show hardware cursor",
		description: "Show the terminal cursor while still positioning it for IME support",
		order: 26,
		control: "cycle",
	},
});

// --- Interaction --------------------------------------------------------------

export const steeringMode = registerSetting({
	key: "steeringMode",
	type: "enum",
	default: "one-at-a-time",
	values: ["one-at-a-time", "all"],
	ui: {
		label: "Steering mode",
		description:
			"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
		order: 10,
		control: "cycle",
	},
});

export const followUpMode = registerSetting({
	key: "followUpMode",
	type: "enum",
	default: "one-at-a-time",
	values: ["one-at-a-time", "all"],
	ui: {
		label: "Follow-up mode",
		description:
			"Enter while streaming queues follow-up messages until the agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
		order: 11,
		control: "cycle",
	},
});

export const doubleEscapeAction = registerSetting({
	key: "doubleEscapeAction",
	type: "enum",
	default: "tree",
	values: ["tree", "fork", "none"],
	ui: {
		label: "Double-escape action",
		description: "Action when pressing Escape twice with empty editor",
		order: 12,
		control: "cycle",
	},
});

export const treeFilterMode = registerSetting({
	key: "treeFilterMode",
	type: "enum",
	default: "default",
	values: ["default", "no-tools", "user-only", "labeled-only", "all"],
	ui: { label: "Tree filter mode", description: "Default filter when opening /tree", order: 13, control: "cycle" },
});

export const editorPaddingX = registerSetting({
	key: "editorPaddingX",
	type: "number",
	default: 0,
	ui: {
		label: "Editor padding",
		description: "Horizontal padding for input editor (0-3)",
		order: 14,
		control: "cycle",
	},
});

export const outputPad = registerSetting({
	key: "outputPad",
	type: "number",
	default: 1,
	parse: (raw) => (raw === 0 || raw === 1 ? raw : undefined),
	ui: {
		label: "Output padding",
		description: "Horizontal padding for user messages, assistant messages, and thinking",
		order: 15,
		control: "cycle",
	},
});

export const autocompleteMaxVisible = registerSetting({
	key: "autocompleteMaxVisible",
	type: "number",
	default: 5,
	ui: {
		label: "Autocomplete max items",
		description: "Max visible items in autocomplete dropdown (3-20)",
		order: 16,
		control: "cycle",
	},
});

export const enableSkillCommands = registerSetting({
	key: "enableSkillCommands",
	type: "boolean",
	default: true,
	ui: { label: "Skill commands", description: "Register skills as /skill:name commands", order: 17, control: "cycle" },
});

// --- Providers and transport --------------------------------------------------

export const transport = registerSetting({
	key: "transport",
	type: "enum",
	default: "auto",
	values: ["sse", "websocket", "websocket-cached", "auto"],
	ui: {
		label: "Transport",
		description: "Preferred transport for providers that support multiple transports",
		order: 30,
		control: "cycle",
	},
});

export const httpIdleTimeoutMs = registerSetting({
	key: "httpIdleTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		label: "HTTP idle timeout",
		description:
			"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
		order: 31,
		control: "submenu",
	},
});

export const cacheWarmingMode = registerSetting({
	key: "cacheWarming",
	type: "enum",
	default: "streaming",
	values: [...CACHE_WARMING_MODES],
	// Global only: each refresh costs money, so a project must not change it.
	globalOnly: true,
	ui: {
		label: "Cache warming",
		description: "off; streaming while the agent runs; idle also between runs while continuation stays profitable",
		order: 32,
		control: "cycle",
	},
});

// --- Context and output -------------------------------------------------------

export const autoCompact = registerSetting({
	key: "compaction.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Auto-compact",
		description: "Automatically compact context when it gets too large",
		order: 5,
		control: "cycle",
	},
});

export const hideThinkingBlock = registerSetting({
	key: "hideThinkingBlock",
	type: "boolean",
	default: false,
	ui: {
		label: "Hide thinking",
		description: "Hide thinking blocks in assistant responses",
		order: 40,
		control: "cycle",
	},
});

export const mermaidRendering = registerSetting({
	key: "markdown.mermaid",
	type: "enum",
	default: "streaming",
	values: ["off", "final", "streaming"],
	ui: {
		label: "Mermaid diagrams",
		description: "Render Mermaid code blocks as Unicode diagrams",
		order: 41,
		control: "cycle",
	},
});

export const showCacheMissNotices = registerSetting({
	key: "showCacheMissNotices",
	type: "boolean",
	default: false,
	ui: {
		label: "Cache miss notices",
		description: "Show transcript notices for cache costs and provider recovery diagnostics",
		order: 42,
		control: "cycle",
	},
});

// --- Startup and reporting ----------------------------------------------------

export const quietStartup = registerSetting({
	key: "quietStartup",
	type: "boolean",
	default: false,
	ui: { label: "Quiet startup", description: "Disable verbose printing at startup", order: 50, control: "cycle" },
});

export const collapseChangelog = registerSetting({
	key: "collapseChangelog",
	type: "boolean",
	default: false,
	ui: {
		label: "Collapse changelog",
		description: "Show condensed changelog after updates",
		order: 51,
		control: "cycle",
	},
});

export const installTelemetry = registerSetting({
	key: "enableInstallTelemetry",
	type: "boolean",
	default: true,
	ui: {
		label: "Install telemetry",
		description: "Send an anonymous version/update ping after changelog-detected updates",
		order: 52,
		control: "cycle",
	},
});

export const defaultProjectTrust = registerSetting({
	key: "defaultProjectTrust",
	type: "enum",
	default: "ask",
	values: ["ask", "always", "never"],
	globalOnly: true,
	ui: {
		label: "Default project trust",
		description: "Fallback behavior when no extension or saved trust decision decides project trust",
		order: 53,
		control: "submenu",
	},
});

// --- Fullscreen mode ----------------------------------------------------------

export const tuiMode = registerSetting({
	key: "tuiMode",
	type: "enum",
	default: "regular",
	values: ["regular", "fullscreen"],
	ui: {
		label: "TUI mode",
		description: "Interface layout; fullscreen mode is experimental",
		order: 60,
		control: "cycle",
	},
});

export const fullscreenExitOutput = registerSetting({
	key: "fullscreenExitOutput",
	type: "enum",
	default: "transcript",
	values: ["transcript", "resume-hint"],
	ui: {
		label: "Fullscreen exit output",
		description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
		order: 61,
		control: "cycle",
	},
});

export const fullscreenScrollbar = registerSetting({
	key: "fullscreenScrollbar",
	type: "enum",
	default: "auto",
	values: ["auto", "always", "hidden"],
	ui: {
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
		order: 62,
		control: "cycle",
	},
});

export const fullscreenCopyOnSelect = registerSetting({
	key: "fullscreenCopyOnSelect",
	type: "boolean",
	default: true,
	ui: {
		label: "Fullscreen copy on select",
		description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
		order: 63,
		control: "cycle",
	},
});

// --- Model roles -------------------------------------------------------------

/**
 * Per-role model preferences, e.g. `{ "smol": "@tiny, xai/grok-4.5" }`.
 *
 * Declared without a `ui` block on purpose: role assignment belongs with the model
 * picker, not a settings row, and a config-file-only descriptor never produces a
 * control. The value is a flat string map so the registry can validate it.
 */
export const modelRoles = registerSetting({
	key: "modelRoles",
	type: "record",
	default: {},
});

// --- Model controls ---------------------------------------------------------
//
// These narrow or rank the model pool. None of them can make an ineligible model
// eligible: they remove candidates or order them, and `selectFailoverCandidate`
// still has the final say. Like `modelRoles` they carry no `ui` block, because a
// settings row would imply a control that is not wired to anything yet.

/**
 * Provider ids excluded from the model pool entirely.
 *
 * Exclusion is a hard filter applied before any role expansion, so a disabled
 * provider cannot re-enter a chain through a fallback or an alias.
 */
export const disabledProviders = registerSetting({
	key: "disabledProviders",
	type: "stringList",
	default: [],
});

/**
 * Model selectors that are allowed, e.g. `["xai/*", "openrouter/anthropic/*"]`.
 *
 * An allowlist. When non-empty, a model that matches no pattern is excluded, so
 * this narrows the pool the same way `disabledProviders` does, only positively.
 */
export const enabledModels = registerSetting({
	key: "enabledModels",
	type: "stringList",
	default: [],
});

/**
 * Provider preference order, e.g. `["openrouter", "opencode"]`.
 *
 * Purely a ranking hint applied after eligibility. It can promote a reachable
 * provider over another reachable one, and it can never resurrect a candidate
 * that failed an access, credential, policy, or cooldown check.
 */
export const modelProviderOrder = registerSetting({
	key: "modelProviderOrder",
	type: "stringList",
	default: [],
});

/**
 * Where a role assignment is persisted: `global` or `project`.
 *
 * A project-scoped role is only readable when the project is trusted, which is
 * enforced by the layer read rather than here, so an untrusted project cannot
 * redirect role resolution by shipping its own config.
 */
export const modelRoleStorage = registerSetting({
	key: "modelRoleStorage",
	type: "enum",
	values: ["global", "project"],
	default: "global",
});

/**
 * Per-role candidate lists tried after a role's own preference list,
 * e.g. `{ smol: ["@tiny", "openrouter/anthropic/claude-haiku-4-5"] }`.
 *
 * Ordering and narrowing data only. This is deliberately not a retry policy: it
 * names candidates, and every one of them still passes the same gates as the
 * role's primary list before Pi can select it.
 */
export const retryFallbackChains = registerSetting({
	key: "retry.fallbackChains",
	type: "stringListMap",
	default: {},
});

// --- Tool approval ------------------------------------------------------------
//
// Approval settings only take effect once a session installs the approval gate.
// They are declared here so the gate can read them through the registry, and so
// the vocabulary lives in one place rather than being re-derived per caller.

/**
 * How much the agent may do without asking.
 *
 * - `always-ask` — prompt for anything above a plain read
 * - `write`      — prompt for process execution
 * - `yolo`       — ask for nothing
 *
 * No `ui` block: this is a security control, and a settings row that cycles
 * through it invites accidental weakening. It is set deliberately in config.
 */
export const toolApprovalMode = registerSetting({
	key: "tools.approvalMode",
	type: "enum",
	values: ["always-ask", "write", "yolo"],
	default: "yolo",
});

/**
 * Per-tool approval policy, e.g. `{ "bash": "deny", "read": "allow" }`.
 *
 * A `record` rather than a `stringListMap`: the value is one decision per tool,
 * not a list. The decision vocabulary is validated on read, so a typo resolves
 * to "no policy" and falls through to the mode ceiling rather than being
 * guessed at.
 *
 * A `deny` here is unconditional: no mode, including `yolo`, overrides it.
 */
export const toolApprovalPolicies = registerSetting({
	key: "tools.approval",
	type: "record",
	default: {},
});


// --- Custom-renderer rows -----------------------------------------------------
// These keep bespoke components (theme picker, model thinking levels, warnings).
// The descriptor records the label and marks the control as a submenu; the picker
// supplies the component, so the custom renderer is preserved rather than
// flattened into a generic cycle.

export const theme = registerSetting({
	key: "theme",
	type: "string",
	default: "",
	ui: { label: "Theme", description: "Color theme for the interface", order: 1, control: "submenu" },
});

export const modelThinkingLevels = registerSetting({
	key: "modelThinkingLevels",
	type: "string",
	default: "",
	// A record rather than a scalar; the picker edits it through a custom component.
	parse: () => "",
	ui: {
		label: "Default thinking level per model",
		description: "Override the default thinking level for specific models.",
		order: 2,
		control: "submenu",
	},
});

export const anthropicExtraUsage = registerSetting({
	key: "warnings.anthropicExtraUsage",
	type: "boolean",
	default: true,
	ui: {
		label: "Anthropic extra usage",
		description: "Warn when Anthropic subscription auth may use paid extra usage",
		order: 3,
		control: "cycle",
	},
});

export const warnings = registerSetting({
	key: "warnings",
	type: "string",
	default: "",
	parse: () => "",
	ui: { label: "Warnings", description: "Enable or disable individual warnings", order: 4, control: "submenu" },
});
