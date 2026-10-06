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

import { DEFAULT_COMPACTION_METHOD_ORDER, parseConfiguredThinkingLevel } from "@earendil-works/pi-ai";
import { registerSetting } from "./settings-registry.ts";
import { parseApprovalPatterns } from "./shell/approval-patterns.ts";

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

// --- Secrets -----------------------------------------------------------------

/**
 * Whether recognized credentials are redacted before content leaves the machine.
 *
 * Defaults to on: the failure mode of leaving it off is silently shipping a
 * credential to a provider, and the failure mode of leaving it on is a
 * placeholder in a transcript, which is visible and recoverable.
 */
export const resizeScrollback = registerSetting({
	key: "tui.resizeScrollback",
	type: "enum",
	// Rebuild is the default because it is the only mode where every visible row is
	// correct. Append leaves the user scrolling through two versions of the same
	// conversation; preserve leaves them scrolling through text that no longer fits.
	default: "rebuild",
	values: ["append", "rebuild", "preserve"],
	parse: (raw) => (raw === "append" || raw === "rebuild" || raw === "preserve" ? raw : undefined),
	ui: {
		label: "Resize Scrollback",
		description: "How a settled terminal resize refreshes transcript rows retained in terminal scrollback",
		tab: "appearance",
		group: "Display",
		control: "submenu",
	},
});

export const codexResetsMinBlockedMinutes = registerSetting({
	key: "codexResets.minBlockedMinutes",
	type: "number",
	default: 30,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Codex Auto-Redeem Min Block",
		description: "Minimum minutes an account must have been blocked before a saved reset is spent on it",
		tab: "providers",
		group: "Services",
	},
});

export const codexResetsKeepCredits = registerSetting({
	key: "codexResets.keepCredits",
	type: "number",
	default: 1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Codex Auto-Redeem Reserve",
		description: "Credits kept in reserve and never spent automatically",
		tab: "providers",
		group: "Services",
	},
});

export const codexResetsSalvageHorizonHours = registerSetting({
	key: "codexResets.salvageHorizonHours",
	type: "number",
	default: 24,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Codex Reset Salvage Horizon",
		description: "Hours before expiry within which an unused credit is salvaged rather than left to lapse",
		tab: "providers",
		group: "Services",
	},
});

export const codexResetsAutoRedeem = registerSetting({
	key: "codexResets.autoRedeem",
	type: "enum",
	// `unset` is a deliberate third state: ask before the first spend, then
	// remember. A boolean has nowhere to put "ask once", and asking on every
	// spend makes the feature unusable.
	default: "unset",
	values: ["unset", "yes", "no"],
	parse: (raw) => (raw === "unset" || raw === "yes" || raw === "no" ? raw : undefined),
	ui: {
		label: "Codex Auto-Redeem Saved Resets",
		description:
			"Spend saved Codex rate-limit resets automatically when a turn is stuck and no other account can take over",
		tab: "providers",
		group: "Services",
		control: "submenu",
	},
});

export const claudeResetsMinBlockedMinutes = registerSetting({
	key: "claudeResets.minBlockedMinutes",
	type: "number",
	default: 30,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Claude Auto-Redeem Min Block",
		description: "Minimum minutes an account must have been blocked before a saved reset is spent on it",
		tab: "providers",
		group: "Services",
	},
});

export const claudeResetsKeepCredits = registerSetting({
	key: "claudeResets.keepCredits",
	type: "number",
	default: 1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Claude Auto-Redeem Reserve",
		description: "Credits kept in reserve and never spent automatically",
		tab: "providers",
		group: "Services",
	},
});

export const claudeResetsSalvageHorizonHours = registerSetting({
	key: "claudeResets.salvageHorizonHours",
	type: "number",
	default: 24,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Claude Reset Salvage Horizon",
		description: "Hours before expiry within which an unused credit is salvaged rather than left to lapse",
		tab: "providers",
		group: "Services",
	},
});

export const claudeResetsAutoRedeem = registerSetting({
	key: "claudeResets.autoRedeem",
	type: "enum",
	// `unset` is a deliberate third state: ask before the first spend, then
	// remember. A boolean has nowhere to put "ask once", and asking on every
	// spend makes the feature unusable.
	default: "unset",
	values: ["unset", "yes", "no"],
	parse: (raw) => (raw === "unset" || raw === "yes" || raw === "no" ? raw : undefined),
	ui: {
		label: "Claude Auto-Redeem Resets",
		description:
			"Spend saved Claude rate-limit resets automatically when a turn is stuck and no other account can take over",
		tab: "providers",
		group: "Services",
		control: "submenu",
	},
});
export const webSearchEnabled = registerSetting({
	key: "web_search.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Web Search",
		description: "Enable the web_search tool for live web results",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const fetchEnabled = registerSetting({
	key: "fetch.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Read URLs",
		description: "Enable the fetch tool for reading URLs",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const fetchProvider = registerSetting({
	key: "providers.fetch",
	type: "enum",
	default: "auto",
	values: ["auto", "direct", "jina", "firecrawl"],
	parse: (raw) => (raw === "auto" || raw === "direct" || raw === "jina" || raw === "firecrawl" ? raw : undefined),
	ui: {
		label: "Fetch Provider",
		description: "How a URL is retrieved when the fetch tool runs",
		tab: "providers",
		group: "Services",
		control: "submenu",
	},
});

export const exaEnabled = registerSetting({
	key: "exa.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Exa",
		description: "Enable the Exa web search provider",
		tab: "providers",
		group: "Services",
		control: "cycle",
	},
});

export const exaSearchDelayMs = registerSetting({
	key: "exa.searchDelayMs",
	type: "number",
	// 0 disables pacing, which is a deliberate choice: a user who has decided their
	// provider tolerates a burst should not be paced.
	default: 1000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Exa Search Delay",
		description: "Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing",
		tab: "providers",
		group: "Services",
	},
});

export const searxngEndpoint = registerSetting({
	key: "searxng.endpoint",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "SearXNG Endpoint",
		description: "Base URL of a self-hosted SearXNG instance used for web search",
		tab: "providers",
		group: "Services",
	},
});
export const toolsArtifactSpillThreshold = registerSetting({
	key: "tools.artifactSpillThreshold",
	type: "number",
	default: 50,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Artifact Spill Threshold (KB)",
		description: "Tool output above this size is saved as an artifact; head and tail are kept inline",
		tab: "tools",
		group: "Output Limits",
	},
});

export const toolsArtifactHeadBytes = registerSetting({
	key: "tools.artifactHeadBytes",
	type: "number",
	default: 2,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Artifact Head Size (KB)",
		description: "Bytes of the head kept inline; 0 makes the view tail-only",
		tab: "tools",
		group: "Output Limits",
	},
});

export const toolsArtifactTailBytes = registerSetting({
	key: "tools.artifactTailBytes",
	type: "number",
	default: 2,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Artifact Tail Size (KB)",
		description: "Bytes of the tail kept inline",
		tab: "tools",
		group: "Output Limits",
	},
});

export const toolsArtifactTailLines = registerSetting({
	key: "tools.artifactTailLines",
	type: "number",
	default: 20,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Artifact Tail Lines",
		description: "Lines of the tail kept, applied before the byte budget",
		tab: "tools",
		group: "Output Limits",
	},
});

export const toolsOutputMaxColumns = registerSetting({
	key: "tools.outputMaxColumns",
	type: "number",
	default: 0,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Output Column Cap",
		description: "Maximum columns per output line; 0 disables the clamp",
		tab: "tools",
		group: "Output Limits",
	},
});
export const todoReminders = registerSetting({
	key: "todo.reminders",
	type: "boolean",
	// On by default: a plan left unfinished is invisible once the turn ends, and the
	// user has to notice it themselves.
	default: true,
	ui: {
		label: "Todo Reminders",
		description: "Remind the agent to complete todos before stopping",
		tab: "tools",
		group: "Todos",
		control: "cycle",
	},
});

export const todoRemindersMax = registerSetting({
	key: "todo.remindersMax",
	type: "number",
	default: 5,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Todo Reminder Limit",
		description: "Largest plan the reminder will nag about; above this it stays quiet",
		tab: "tools",
		group: "Todos",
	},
});

export const todoEager = registerSetting({
	key: "todo.eager",
	type: "enum",
	default: "off",
	values: ["off", "prompt", "auto"],
	parse: (raw) => (raw === "off" || raw === "prompt" || raw === "auto" ? raw : undefined),
	ui: {
		label: "Create Todos Automatically",
		description: "Whether a multi-step request is turned into a todo plan without being asked",
		tab: "tools",
		group: "Todos",
		control: "submenu",
	},
});

export const tasksTodoClearDelay = registerSetting({
	key: "tasks.todoClearDelay",
	type: "number",
	default: 0,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Todo Auto-Clear Delay",
		description: "Milliseconds a completed plan stays before it is cleared from the panel",
		tab: "tools",
		group: "Todos",
	},
});
export const browserEnabled = registerSetting({
	key: "browser.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Browser",
		description: "Enable the browser tool",
		tab: "tools",
		group: "Grep & Browser",
		control: "cycle",
	},
});

export const browserCdpUrl = registerSetting({
	key: "browser.cdpUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Browser CDP URL",
		description: "Attach to an existing browser over CDP instead of launching one",
		tab: "tools",
		group: "Grep & Browser",
	},
});

export const browserRelay = registerSetting({
	key: "browser.relay",
	type: "boolean",
	default: true,
	ui: {
		label: "Browser Relay",
		description: "Reach the browser through a relay rather than locally",
		tab: "tools",
		group: "Grep & Browser",
		control: "cycle",
	},
});

export const browserRelayUrl = registerSetting({
	key: "browser.relayUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Browser Relay URL",
		description: "Base URL of the browser relay",
		tab: "tools",
		group: "Grep & Browser",
	},
});

export const browserHeadless = registerSetting({
	key: "browser.headless",
	type: "boolean",
	default: true,
	ui: {
		label: "Headless Browser",
		description: "Launch the browser headless",
		tab: "tools",
		group: "Grep & Browser",
		control: "cycle",
	},
});

export const browserFreezeOnTurnEnd = registerSetting({
	key: "browser.freezeOnTurnEnd",
	type: "boolean",
	default: true,
	ui: {
		label: "Freeze Browser Tabs On Turn End",
		description:
			"Freeze owned headless tabs when a turn settles so animated pages stop burning CPU and GPU while idle. Tabs unfreeze automatically on next use; pass persist:true on open to opt a tab out",
		tab: "tools",
		group: "Grep & Browser",
		control: "cycle",
	},
});

export const browserIdleCloseSec = registerSetting({
	key: "browser.idleCloseSec",
	type: "number",
	default: 1800,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Browser Idle Close Timeout",
		description:
			"Close owned headless tabs idle longer than this many seconds (0 = never; session dispose still reaps). Applies only to tabs this session launched headless, never a CDP, relay or spawned browser",
		tab: "tools",
		group: "Grep & Browser",
	},
});

export const browserScreenshotDir = registerSetting({
	key: "browser.screenshotDir",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Screenshot Directory",
		description: "Directory screenshots are written to",
		tab: "tools",
		group: "Grep & Browser",
	},
});
export const mcpEnableProjectConfig = registerSetting({
	key: "mcp.enableProjectConfig",
	type: "boolean",
	default: true,
	ui: {
		label: "MCP Project Config",
		description: "Allow a project to declare its own MCP servers",
		tab: "tools",
		group: "Discovery & MCP",
		control: "cycle",
	},
});

export const mcpStartupTimeoutMs = registerSetting({
	key: "mcp.startupTimeoutMs",
	type: "number",
	default: 250,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "MCP Startup Window",
		description: "Milliseconds to wait for initial MCP tool discovery; 0 waits until connections settle",
		tab: "tools",
		group: "Discovery & MCP",
	},
});

export const mcpRenderMarkdownResults = registerSetting({
	key: "mcp.renderMarkdownResults",
	type: "boolean",
	default: true,
	ui: {
		label: "MCP Markdown Results",
		description: "Render MCP results as markdown when the content is markdown",
		tab: "tools",
		group: "Discovery & MCP",
		control: "cycle",
	},
});

export const mcpNotifications = registerSetting({
	key: "mcp.notifications",
	type: "boolean",
	default: false,
	ui: {
		label: "MCP Update Injection",
		description: "Inject MCP resource updates into the conversation",
		tab: "tools",
		group: "Discovery & MCP",
		control: "cycle",
	},
});

export const mcpNotificationDebounceMs = registerSetting({
	key: "mcp.notificationDebounceMs",
	type: "number",
	default: 500,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "MCP Notification Debounce",
		description:
			"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
		tab: "tools",
		group: "Discovery & MCP",
	},
});
export const displaySmoothStreaming = registerSetting({
	key: "display.smoothStreaming",
	type: "boolean",
	default: true,
	ui: {
		label: "Smooth Streaming",
		description: "Redraw streamed text smoothly rather than per chunk",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const displayHideToolActivity = registerSetting({
	key: "display.hideToolActivity",
	type: "boolean",
	default: false,
	ui: {
		label: "Hide Tool Activity",
		description: "Draw a short summary of a turn's tool activity instead of every call",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const displayShowTokenUsage = registerSetting({
	key: "display.showTokenUsage",
	type: "boolean",
	default: true,
	ui: {
		label: "Show Token Usage",
		description: "Show token usage on assistant message rows",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const displayShowTurnTime = registerSetting({
	key: "display.showTurnTime",
	type: "boolean",
	default: true,
	ui: {
		label: "Show Turn Time",
		description: "Show the total prompt-to-yield time on assistant message usage rows",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const displayCacheMissMarker = registerSetting({
	key: "display.cacheMissMarker",
	type: "boolean",
	default: false,
	ui: {
		label: "Cache Miss Marker",
		description: "Show a divider after an assistant turn whose request lost the prompt cache",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const displayCollapseCompacted = registerSetting({
	key: "display.collapseCompacted",
	type: "boolean",
	default: true,
	ui: {
		label: "Collapse Compacted History",
		description:
			"Collapse pre-compaction history behind the summary divider; disable to keep the full transcript inline with dividers at each compaction point",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiImeSafeCursor = registerSetting({
	key: "tui.imeSafeCursor",
	type: "boolean",
	default: true,
	ui: {
		label: "IME-Safe Prompt Layout",
		description: "Layout the prompt so an IME candidate window does not cover it",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiHyperlinksEnabled = registerSetting({
	key: "tui.hyperlinks",
	type: "boolean",
	default: true,
	ui: {
		label: "Terminal Hyperlinks",
		description: "Emit OSC 8 hyperlinks for paths",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiTightLayout = registerSetting({
	key: "tui.tight",
	type: "boolean",
	default: false,
	ui: {
		label: "Tight Layout",
		description: "Use a compact layout with reduced padding",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});
export const samplingTemperature = registerSetting({
	key: "temperature",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Temperature",
		description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});

export const samplingTopP = registerSetting({
	key: "topP",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Top P",
		description: "Nucleus sampling cutoff (0 to 1, -1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});

export const samplingTopK = registerSetting({
	key: "topK",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Top K",
		description: "Limit sampling to the K most likely tokens (-1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});

export const samplingMinP = registerSetting({
	key: "minP",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Min P",
		description: "Minimum probability relative to the most likely token (0 to 1, -1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});

export const samplingPresencePenalty = registerSetting({
	key: "presencePenalty",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Presence Penalty",
		description: "Penalise tokens already present (-1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});

export const samplingRepetitionPenalty = registerSetting({
	key: "repetitionPenalty",
	type: "number",
	// -1 is the sentinel meaning "provider default". It is not a value: a zero here
	// would make an unconfigured session deterministic, which is a change the user
	// never asked for.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined),
	ui: {
		label: "Repetition Penalty",
		description: "Penalise repeated tokens (-1 = provider default)",
		tab: "model",
		group: "Sampling",
	},
});
export const taskMaxConcurrency = registerSetting({
	key: "task.maxConcurrency",
	type: "number",
	default: 32,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Max Concurrent Tasks",
		description: "Maximum number of subagents running concurrently",
		tab: "tasks",
		group: "Subagents",
	},
});

export const taskMaxRecursionDepth = registerSetting({
	key: "task.maxRecursionDepth",
	type: "number",
	default: 2,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Max Task Recursion",
		description: "How many levels deep subagents can spawn their own subagents",
		tab: "tasks",
		group: "Subagents",
	},
});

export const taskSoftRequestBudget = registerSetting({
	key: "task.softRequestBudget",
	type: "number",
	default: 200,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Soft Subagent Request Budget",
		description:
			"Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up notice; at 1.5x the run is force-stopped and the agent must yield its partial findings. 0 disables the guard",
		tab: "tasks",
		group: "Subagents",
	},
});

export const taskMaxEffort = registerSetting({
	key: "task.maxEffort",
	type: "number",
	default: 5,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Maximum Per-Spawn Effort",
		description: "Highest reasoning effort a spawned subagent may be given",
		tab: "tasks",
		group: "Subagents",
	},
});

export const taskEager = registerSetting({
	key: "task.eager",
	type: "boolean",
	default: true,
	ui: {
		label: "Prefer Task Delegation",
		description: "Prefer delegating a self-contained piece of work to a subagent over doing it inline",
		tab: "tasks",
		group: "Subagents",
		control: "cycle",
	},
});

export const taskBatch = registerSetting({
	key: "task.batch",
	type: "boolean",
	default: true,
	ui: {
		label: "Batch Task Calls",
		description: "Batch several task calls in one turn rather than issuing them one at a time",
		tab: "tasks",
		group: "Subagents",
		control: "cycle",
	},
});

export const taskEnableLsp = registerSetting({
	key: "task.enableLsp",
	type: "boolean",
	default: true,
	ui: {
		label: "LSP in Subagents",
		description: "Give a subagent language-server context for the files it is working on",
		tab: "tasks",
		group: "Subagents",
		control: "cycle",
	},
});

export const taskEnableEffort = registerSetting({
	key: "task.enableEffort",
	type: "boolean",
	default: true,
	ui: {
		label: "Per-Task Effort",
		description: "Let a task request a specific reasoning effort for its subagent",
		tab: "tasks",
		group: "Subagents",
		control: "cycle",
	},
});
export const compactionThresholdPercent = registerSetting({
	key: "compaction.thresholdPercent",
	type: "number",
	// -1 is the sentinel meaning "not set", which is what makes a percentage and a
	// token limit independently optional and the token limit able to win.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
	ui: {
		label: "Compaction Threshold",
		description: "Percent threshold for context maintenance; -1 uses the legacy reserve-based behaviour",
		tab: "context",
		group: "Compaction",
	},
});

export const compactionThresholdTokens = registerSetting({
	key: "compaction.thresholdTokens",
	type: "number",
	// -1 is the sentinel meaning "not set", which is what makes a percentage and a
	// token limit independently optional and the token limit able to win.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
	ui: {
		label: "Compaction Token Limit",
		description: "Fixed token limit for context maintenance; overrides the percentage when set",
		tab: "context",
		group: "Compaction",
	},
});

export const compactionIdleThresholdTokens = registerSetting({
	key: "compaction.idleThresholdTokens",
	type: "number",
	// -1 is the sentinel meaning "not set", which is what makes a percentage and a
	// token limit independently optional and the token limit able to win.
	default: 50000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
	ui: {
		label: "Idle Compaction Threshold",
		description: "Context size at which an idle session becomes eligible for compaction",
		tab: "context",
		group: "Compaction",
	},
});

export const compactionIdleTimeoutSeconds = registerSetting({
	key: "compaction.idleTimeoutSeconds",
	type: "number",
	// -1 is the sentinel meaning "not set", which is what makes a percentage and a
	// token limit independently optional and the token limit able to win.
	default: 300,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined),
	ui: {
		label: "Idle Compaction Delay",
		description: "Seconds a session must be idle before it is compacted",
		tab: "context",
		group: "Compaction",
	},
});

export const compactionIdleEnabled = registerSetting({
	key: "compaction.idleEnabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Idle Compaction",
		description: "Compact a session that has been idle long enough, at no cost to a running turn",
		tab: "context",
		group: "Compaction",
		control: "cycle",
	},
});
export const grepContextBefore = registerSetting({
	key: "grep.contextBefore",
	type: "number",
	default: 1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Grep Context Before",
		description: "Lines of context before each grep match",
		tab: "tools",
		group: "Grep & Browser",
	},
});

export const grepContextAfter = registerSetting({
	key: "grep.contextAfter",
	type: "number",
	default: 1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Grep Context After",
		description: "Lines of context after each grep match",
		tab: "tools",
		group: "Grep & Browser",
	},
});

export const grepEnabled = registerSetting({
	key: "grep.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Grep",
		description: "Enable the grep tool for searching file contents",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const globEnabled = registerSetting({
	key: "glob.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Glob",
		description: "Enable the glob tool for matching file paths",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const extensionHandlersToolCallTimeoutMs = registerSetting({
	key: "extensionHandlers.toolCallTimeoutMs",
	type: "number",
	default: 30000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Tool Call Handler Timeout (ms)",
		description: "Milliseconds an extension tool-call handler may run before it is abandoned",
		tab: "tools",
		group: "Available Tools",
	},
});
export const workspaceAdditionalDirectories = registerSetting({
	key: "workspace.additionalDirectories",
	type: "stringList",
	default: [],
	ui: {
		label: "Additional Workspace Dirs",
		description:
			"Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended.",
		tab: "context",
		group: "General",
	},
});

export const contextPromotionEnabled = registerSetting({
	key: "contextPromotion.enabled",
	type: "boolean",
	// Off by default: promoting swaps the model mid-session, which changes the
	// behaviour of a conversation the user believes is continuing.
	default: false,
	ui: {
		label: "Auto-Promote Context",
		description: "Promote to a larger-context model on context overflow instead of compacting",
		tab: "context",
		group: "General",
		control: "cycle",
	},
});
export const imagesUrlsEnabled = registerSetting({
	key: "images.urls.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Serve Images as URLs",
		description: "Publish images once and pass a link, rather than sending them inline with every turn",
		tab: "model",
		group: "Vision",
		control: "cycle",
	},
});

export const imagesDescribeForTextModels = registerSetting({
	key: "images.describeForTextModels",
	type: "boolean",
	default: true,
	ui: {
		label: "Describe Images for Text Models",
		description: "Describe an image in text when the active model cannot accept image input",
		tab: "model",
		group: "Vision",
		control: "cycle",
	},
});

export const imagesUrlsTtlHours = registerSetting({
	key: "images.urls.ttlHours",
	type: "number",
	default: 72,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Image URL Lifetime (hours)",
		description:
			"Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs",
		tab: "model",
		group: "Vision",
	},
});

export const imagesUrlsBindHost = registerSetting({
	key: "images.urls.bindHost",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Image URL Bind Host",
		description: "Host and port the image broker binds to, as host:port",
		tab: "model",
		group: "Vision",
	},
});

export const imagesUrlsPublicBaseUrl = registerSetting({
	key: "images.urls.publicBaseUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Image URL Public Base",
		description:
			"Public base URL for image links, when the broker is reachable through a different address than it binds",
		tab: "model",
		group: "Vision",
	},
});

export const imagesUrlsCommand = registerSetting({
	key: "images.urls.command",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Image Upload Command",
		description: "Command that uploads an image and prints its URL, used instead of the local broker",
		tab: "model",
		group: "Vision",
	},
});
export const mnemopiNoEmbeddings = registerSetting({
	key: "mnemopi.noEmbeddings",
	type: "boolean",
	// Off by default: vector recall is the better retrieval, and this setting is a
	// deliberate trade for determinism rather than a cheaper equivalent.
	default: false,
	ui: {
		label: "Mnemopi Disable Embeddings",
		description: "Force deterministic FTS-only recall instead of vector embeddings",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});

export const mnemopiLlmMode = registerSetting({
	key: "mnemopi.llmMode",
	type: "enum",
	default: "none",
	values: ["none", "managed", "remote"],
	parse: (raw) => (raw === "none" || raw === "managed" || raw === "remote" ? raw : undefined),
	ui: {
		label: "Mnemopi LLM Mode",
		description: "Whether retrieval uses no model, a managed one, or a configured remote endpoint",
		tab: "memory",
		group: "Mnemopi",
		control: "submenu",
	},
});

export const mnemopiLlmBaseUrl = registerSetting({
	key: "mnemopi.llmBaseUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Mnemopi LLM Base URL",
		description: "External endpoint for retrieval, authoritative over a managed model",
		tab: "memory",
		group: "Mnemopi",
	},
});
export const bashEnabled = registerSetting({
	key: "bash.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Bash",
		description: "Enable the bash tool",
		tab: "shell",
		group: "Bash",
		control: "cycle",
	},
});

export const bashAllowCompoundCommands = registerSetting({
	key: "bash.allowCompoundCommands",
	type: "boolean",
	// Off by default. Turning it on lets a && chain be judged segment by segment,
	// which is more accurate - and only safe because an unsegmentable chain falls
	// back to one opaque command rather than being waved through.
	default: false,
	ui: {
		label: "Allow Compound Commands",
		description:
			"Evaluate literal && chains per command; unmatched commands use normal bash approval policy and mode",
		tab: "shell",
		group: "Bash",
		control: "cycle",
	},
});
export const checkpointEnabled = registerSetting({
	key: "checkpoint.enabled",
	type: "boolean",
	// Off by default, as in the reference: the tools exist and the model is told
	// when they are active, but a session is not turned into an investigation loop
	// by default.
	default: false,
	ui: {
		label: "Checkpoint/Rewind",
		description: "Enable the checkpoint and rewind tools for context checkpointing",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});
export const shareRedactSecrets = registerSetting({
	key: "share.redactSecrets",
	type: "boolean",
	default: true,
	ui: {
		label: "Share Secret Redaction",
		description: "Redact configured secrets from a session before it is published",
		tab: "interaction",
		group: "Share",
		control: "cycle",
	},
});

export const shareServerUrl = registerSetting({
	key: "share.serverUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Share Server",
		description: "Base URL of the server a session is published to",
		tab: "interaction",
		group: "Share",
	},
});

export const shareStore = registerSetting({
	key: "share.store",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Share Store",
		description: "Where a published session is stored",
		tab: "interaction",
		group: "Share",
	},
});
export const hindsightApiUrl = registerSetting({
	key: "hindsight.apiUrl",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Hindsight API URL",
		description: "Base URL of the Hindsight service",
		tab: "memory",
		group: "Hindsight",
	},
});

export const hindsightApiToken = registerSetting({
	key: "hindsight.apiToken",
	type: "string",
	default: "",
	// Masked in the panel: this is a bearer credential.
	revealLength: true,
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Hindsight API Token",
		description: "Bearer token for the Hindsight service",
		tab: "memory",
		group: "Hindsight",
	},
});

export const hindsightBankId = registerSetting({
	key: "hindsight.bankId",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Hindsight Bank ID",
		description: "Bank to use; defaults to the bankIdPrefix",
		tab: "memory",
		group: "Hindsight",
	},
});

export const hindsightScoping = registerSetting({
	key: "hindsight.scoping",
	type: "enum",
	default: "global",
	values: ["global", "per-project", "per-project-tagged"],
	parse: (raw) => (raw === "global" || raw === "per-project" || raw === "per-project-tagged" ? raw : undefined),
	ui: {
		label: "Hindsight Scoping",
		description:
			"global = one shared bank; per-project = a bank per project; per-project-tagged = one bank filtered by a project tag",
		tab: "memory",
		group: "Hindsight",
	},
});

export const hindsightAutoRecall = registerSetting({
	key: "hindsight.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		label: "Hindsight Auto Recall",
		description: "Recall from Hindsight on the first turn of each session",
		tab: "memory",
		group: "Hindsight",
		control: "cycle",
	},
});

export const hindsightAutoRetain = registerSetting({
	key: "hindsight.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		label: "Hindsight Auto Retain",
		description: "Retain conversation content to Hindsight as it accumulates",
		tab: "memory",
		group: "Hindsight",
		control: "cycle",
	},
});

export const hindsightRetainMode = registerSetting({
	key: "hindsight.retainMode",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Hindsight Retain Mode",
		description: "full-session = upsert one document per session; last-turn = chunked",
		tab: "memory",
		group: "Hindsight",
	},
});

export const hindsightMentalModelsEnabled = registerSetting({
	key: "hindsight.mentalModelsEnabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Hindsight Mental Models",
		description: "Let the service maintain derived models over retained memories",
		tab: "memory",
		group: "Hindsight",
		control: "cycle",
	},
});
export const ttsrEnabled = registerSetting({
	key: "ttsr.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "TTSR",
		// Off by default, and honest about it: `core/rules/ttsr.ts` is implemented but
		// has no production importer, so no rule is ever evaluated. A user turning this
		// on is otherwise told the agent will inject a rule, and nothing happens.
		description: "Reserved: the TTSR rule engine is not wired in PrimePi, so this setting currently has no effect",
		tab: "context",
		group: "Rules (TTSR)",
		control: "cycle",
	},
});

export const ttsrJudge = registerSetting({
	key: "ttsr.judge",
	type: "enum",
	default: "auto",
	values: ["auto", "on", "off"],
	parse: (raw) => (raw === "auto" || raw === "on" || raw === "off" ? raw : undefined),
	ui: {
		label: "Judged Rules",
		description:
			"Ask the judge model role about completed replies, reasoning and tool calls; a yes injects the rule as a warning",
		tab: "context",
		group: "Rules (TTSR)",
		control: "submenu",
	},
});

export const ttsrInterruptMode = registerSetting({
	key: "ttsr.interruptMode",
	type: "enum",
	default: "always",
	values: ["never", "prose-only", "tool-only", "always"],
	parse: (raw) =>
		raw === "never" || raw === "prose-only" || raw === "tool-only" || raw === "always" ? raw : undefined,
	ui: {
		label: "TTSR Interrupt Mode",
		description: "When to interrupt mid-stream vs inject a warning after completion",
		tab: "context",
		group: "Rules (TTSR)",
		control: "submenu",
	},
});

export const ttsrRepeatMode = registerSetting({
	key: "ttsr.repeatMode",
	type: "enum",
	default: "once",
	values: ["once", "after-gap"],
	parse: (raw) => (raw === "once" || raw === "after-gap" ? raw : undefined),
	ui: {
		label: "TTSR Repeat Mode",
		description: "How rules can repeat: once per session or after a message gap",
		tab: "context",
		group: "Rules (TTSR)",
		control: "submenu",
	},
});

export const ttsrRepeatGap = registerSetting({
	key: "ttsr.repeatGap",
	type: "number",
	default: 10,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "TTSR Repeat Gap",
		description: "Messages before a rule can trigger again",
		tab: "context",
		group: "Rules (TTSR)",
	},
});

export const ttsrBuiltinRules = registerSetting({
	key: "ttsr.builtinRules",
	type: "boolean",
	default: true,
	ui: {
		label: "Built-in Rules",
		description: "Enable the rules shipped with the reference",
		tab: "context",
		group: "Rules (TTSR)",
		control: "cycle",
	},
});
/**
 * Ordered bash approval rules, e.g.
 * `[{ "match": "rm -rf *", "approval": "deny" }]`.
 *
 * An `objectList`, and that is load-bearing rather than cosmetic. Declared as a
 * `record`, the registry required every value to be a string and refused the
 * array the setting documents — so `bash.patterns` was a setting that could be
 * written but never populated, and the pattern rules downstream of it judged
 * an empty list no matter what the user configured.
 *
 * `parse` normalises each entry through the same parser the approval authority
 * uses, so a malformed rule is dropped here for the same reason and by the same
 * code that would have dropped it there. One bad rule must not disable the rules
 * around it, so an entry that survives the array check but not the entry schema
 * still leaves the list usable.
 */
export const bashPatterns = registerSetting({
	key: "bash.patterns",
	type: "objectList",
	default: [],
	parse: (raw) => {
		if (!Array.isArray(raw)) return undefined;
		// `Record<string, unknown>[]` because that is what `SettingObjectList` is: a
		// structural wire shape, so a descriptor may carry any object entry. The
		// approval authority re-parses through `parseApprovalPatterns`, which is where
		// `match`/`approval` regain their types.
		const kept: Record<string, unknown>[] = [];
		for (const entry of parseApprovalPatterns(raw)) kept.push({ ...entry });
		// Rules that do not survive the entry schema are dropped rather than
		// rejecting the whole list, matching the authority's own tolerance.
		return kept;
	},
	ui: {
		label: "Bash Approval Patterns",
		description:
			"Ordered bash command approval rules. Each item has match and approval fields; only * wildcards are supported.",
		tab: "shell",
		group: "Bash",
	},
});

export const bashAutoBackgroundEnabled = registerSetting({
	key: "bash.autoBackground.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Bash Auto-Background",
		description: "Move a long-running shell command to the background automatically",
		tab: "shell",
		group: "Bash",
		control: "cycle",
	},
});

export const bashDirenv = registerSetting({
	key: "bash.direnv",
	type: "enum",
	default: "off",
	values: ["off", "load", "strict"],
	parse: (raw) => (raw === "off" || raw === "load" || raw === "strict" ? raw : undefined),
	ui: {
		label: "direnv Auto-Load",
		description: "Load a .envrc through direnv before running a shell command",
		tab: "shell",
		group: "Bash",
		control: "submenu",
	},
});

export const bashInterceptorEnabled = registerSetting({
	key: "bashInterceptor.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Bash Interceptor",
		description: "Rewrite shell commands through an interceptor before approval",
		tab: "shell",
		group: "Bash",
		control: "cycle",
	},
});
export const editMode = registerSetting({
	key: "edit.mode",
	type: "enum",
	default: "replace",
	values: ["replace", "insert", "patch"],
	parse: (raw) => (raw === "replace" || raw === "insert" || raw === "patch" ? raw : undefined),
	ui: {
		label: "Edit Mode",
		description: "How an edit is applied to a file",
		tab: "files",
		group: "Editing",
		control: "submenu",
	},
});

export const editFuzzyMatch = registerSetting({
	key: "edit.fuzzyMatch",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: true,
	ui: {
		label: "Fuzzy Match",
		description: "Fall back to a fuzzy match when an exact anchor is not found",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const editFuzzyThreshold = registerSetting({
	key: "edit.fuzzyThreshold",
	type: "number",
	default: 0.8,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Fuzzy Match Threshold",
		description: "Similarity a fuzzy match must reach",
		tab: "files",
		group: "Editing",
	},
});

export const editStreamingAbort = registerSetting({
	key: "edit.streamingAbort",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: true,
	ui: {
		label: "Abort on Failed Preview",
		description: "Refuse an edit whose preview does not apply cleanly",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const editEnforceSeenLines = registerSetting({
	key: "edit.enforceSeenLines",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: true,
	ui: {
		label: "Enforce Seen-Line Guard",
		description: "Reject edits anchored on lines a prior read or search never displayed in full",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const editBlockAutoGenerated = registerSetting({
	key: "edit.blockAutoGenerated",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: true,
	ui: {
		label: "Block Auto-Generated Files",
		description: "Refuse to edit a file carrying a generated-code marker",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const editBlackboxEnabled = registerSetting({
	key: "edit.blackbox.enabled",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: false,
	ui: {
		label: "Record Parse Regressions",
		description: "Record edits that a parser mishandled, for a later fix",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const editAutoRepairEnabled = registerSetting({
	key: "edit.autoRepair.enabled",
	type: "boolean",
	// Default chosen so the safety property is on without the user opting in.
	default: false,
	ui: {
		label: "Auto-Repair Parse Regressions",
		description: "Repair a recorded parse regression on the next edit",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});
export const lspEnabled = registerSetting({
	key: "lsp.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "LSP",
		description: "Enable language-server integration for completion and diagnostics",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspLazy = registerSetting({
	key: "lsp.lazy",
	type: "boolean",
	default: true,
	ui: {
		label: "Lazy LSP Startup",
		description: "Start language servers on first use rather than at session startup",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspShared = registerSetting({
	key: "lsp.shared",
	type: "boolean",
	default: true,
	ui: {
		label: "Shared Language Servers",
		description:
			"Share one language server per project across instances via the daemon broker, falling back to private servers when unavailable",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspFormatOnWrite = registerSetting({
	key: "lsp.formatOnWrite",
	type: "boolean",
	default: true,
	ui: {
		label: "Format on Write",
		description: "Format a file with its language server after a successful edit",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspDiagnosticsOnWrite = registerSetting({
	key: "lsp.diagnosticsOnWrite",
	type: "boolean",
	default: true,
	ui: {
		label: "Diagnostics on Write",
		description: "Request diagnostics after writing a file",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspDiagnosticsOnEdit = registerSetting({
	key: "lsp.diagnosticsOnEdit",
	type: "boolean",
	default: true,
	ui: {
		label: "Diagnostics on Edit",
		description: "Request diagnostics after editing a file",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const lspDiagnosticsDeduplicate = registerSetting({
	key: "lsp.diagnosticsDeduplicate",
	type: "boolean",
	default: true,
	ui: {
		label: "Deduplicate Diagnostics",
		description: "Collapse identical diagnostics reported from several servers",
		tab: "files",
		group: "LSP",
		control: "cycle",
	},
});

export const proseOnlyThinking = registerSetting({
	key: "proseOnlyThinking",
	type: "boolean",
	default: true,
	ui: {
		label: "Prose Only Thinking",
		description:
			"Omit code blocks from thinking summaries and replace them with an ellipsis, keeping the surrounding reasoning",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});

export const omitThinking = registerSetting({
	key: "omitThinking",
	type: "boolean",
	default: false,
	ui: {
		label: "Omit Thinking summaries",
		description: "Instruct upstream providers to completely omit thinking summaries from responses, where supported",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});

export const externalThinking = registerSetting({
	key: "externalThinking",
	type: "boolean",
	default: false,
	ui: {
		label: "External Thinking",
		description: "Private scratchpad, not shown to the user; disables supported reasoning on GPT, Claude and Gemini",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});
export const planEnabled = registerSetting({
	key: "plan.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Plan Mode",
		description: "Enable plan mode for read-only exploration and planning before execution",
		tab: "tasks",
		group: "Modes",
		control: "cycle",
	},
});

export const planDefaultOnStartup = registerSetting({
	key: "plan.defaultOnStartup",
	type: "boolean",
	default: false,
	ui: {
		label: "Start in Plan Mode",
		description: "Automatically enter plan mode at the start of every new session",
		tab: "tasks",
		group: "Modes",
		control: "cycle",
	},
});

export const planAutosave = registerSetting({
	key: "plan.autosave",
	type: "boolean",
	default: false,
	ui: {
		label: "Autosave Plans",
		description: "Automatically save approved plans to disk when plan mode completes",
		tab: "tasks",
		group: "Modes",
		control: "cycle",
	},
});

export const goalEnabled = registerSetting({
	key: "goal.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Goal Mode",
		description: "Track an explicit goal for the session and report progress against it",
		tab: "tasks",
		group: "Modes",
		control: "cycle",
	},
});

export const goalStatusInFooter = registerSetting({
	key: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		label: "Goal Status in Footer",
		description: "Show the current goal in the status footer",
		tab: "tasks",
		group: "Modes",
		control: "cycle",
	},
});
export const pythonKernelMode = registerSetting({
	key: "python.kernelMode",
	type: "enum",
	// Session by default: a persistent kernel lets a models second snippet
	// reference what its first one built. Per-call is the isolation choice.
	default: "session",
	values: ["session", "per-call"],
	parse: (raw) => (raw === "session" || raw === "per-call" ? raw : undefined),
	ui: {
		label: "Python Kernel Mode",
		description: "Keep the IPython kernel alive across eval calls, or start a fresh one each time",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "submenu",
	},
});

export const pythonInterpreter = registerSetting({
	key: "python.interpreter",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" ? raw.trim() : ""),
	ui: {
		label: "Python Interpreter",
		description:
			"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
		tab: "shell",
		group: "Eval & Runtimes",
	},
});
export const commandsEnableClaudeUser = registerSetting({
	key: "commands.enableClaudeUser",
	type: "boolean",
	default: false,
	ui: {
		label: "Claude User Commands",
		description: "Load commands from ~/.claude/commands/",
		tab: "tasks",
		group: "Commands & Skills",
		control: "cycle",
	},
});

export const commandsEnableClaudeProject = registerSetting({
	key: "commands.enableClaudeProject",
	type: "boolean",
	default: true,
	ui: {
		label: "Claude Project Commands",
		description: "Load commands from the projects .claude/commands/ directory",
		tab: "tasks",
		group: "Commands & Skills",
		control: "cycle",
	},
});

export const commandsEnableOpencodeUser = registerSetting({
	key: "commands.enableOpencodeUser",
	type: "boolean",
	default: false,
	ui: {
		label: "OpenCode User Commands",
		description: "Load commands from your own user-level OpenCode commands directory",
		tab: "tasks",
		group: "Commands & Skills",
		control: "cycle",
	},
});

export const commandsEnableOpencodeProject = registerSetting({
	key: "commands.enableOpencodeProject",
	type: "boolean",
	default: true,
	ui: {
		label: "OpenCode Project Commands",
		description: "Load commands from the projects OpenCode commands directory",
		tab: "tasks",
		group: "Commands & Skills",
		control: "cycle",
	},
});
export const taskIsolationEnabled = registerSetting({
	key: "task.isolation.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Isolate Subagents",
		description: "Give a delegated task its own worktree so it cannot dirty the working tree you are looking at",
		tab: "tasks",
		group: "Isolation",
		control: "cycle",
	},
});

export const taskIsolationMerge = registerSetting({
	key: "task.isolation.merge",
	type: "enum",
	default: "patch",
	values: ["patch", "branch"],
	parse: (raw) => (raw === "patch" || raw === "branch" ? raw : undefined),
	ui: {
		label: "Isolation Merge Strategy",
		description:
			"How isolated task changes are integrated: combine diffs and git apply, or commit per task and merge with --no-ff",
		tab: "tasks",
		group: "Isolation",
		control: "submenu",
	},
});

export const taskIsolationCommits = registerSetting({
	key: "task.isolation.commits",
	type: "enum",
	default: "generic",
	values: ["generic", "ai"],
	parse: (raw) => (raw === "generic" || raw === "ai" ? raw : undefined),
	ui: {
		label: "Isolation Commit Style",
		description: "Commit message style for nested repo changes: a static message, or one generated from the diff",
		tab: "tasks",
		group: "Isolation",
		control: "submenu",
	},
});

export const taskIsolationApply = registerSetting({
	key: "task.isolation.apply",
	type: "boolean",
	default: false,
	ui: {
		label: "Apply Isolated Changes",
		description:
			"Integrate a finished task's changes; off means they are discarded and the working tree is left untouched",
		tab: "tasks",
		group: "Isolation",
		control: "cycle",
	},
});

export const worktreeClone = registerSetting({
	key: "worktree.clone",
	type: "boolean",
	default: false,
	ui: {
		label: "Clone Checkout into Worktrees",
		description: "Clone the checkout into each worktree rather than adding one from the repository",
		tab: "tasks",
		group: "Isolation",
		control: "cycle",
	},
});

export const worktreeCleanSource = registerSetting({
	key: "worktree.cleanSource",
	type: "boolean",
	default: false,
	ui: {
		label: "Clean Source Checkout on /wt",
		description: "Clean the source checkout when a worktree is removed",
		tab: "tasks",
		group: "Isolation",
		control: "cycle",
	},
});
export const terminalShowProgress = registerSetting({
	key: "terminal.showProgress",
	type: "boolean",
	default: false,
	ui: {
		label: "Native Terminal Progress",
		description: "Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiMouse = registerSetting({
	key: "tui.mouse",
	type: "boolean",
	default: false,
	ui: {
		label: "Mouse Click-to-Focus",
		description: "Click in the terminal to focus the agent input",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiTitleState = registerSetting({
	key: "tui.titleState",
	type: "boolean",
	default: true,
	ui: {
		label: "Terminal Title Run State",
		description: "Show the run state in the terminal title",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});

export const tuiTitleSpinner = registerSetting({
	key: "tui.titleSpinner",
	type: "enum",
	default: "off",
	values: ["off", "dots", "braille"],
	parse: (raw) => (raw === "off" || raw === "dots" || raw === "braille" ? raw : undefined),
	ui: {
		label: "Terminal Title Spinner",
		description: "Animate a spinner in the terminal title while the agent is working",
		tab: "appearance",
		group: "Display",
		control: "submenu",
	},
});

export const taskShowResolvedModelBadge = registerSetting({
	key: "task.showResolvedModelBadge",
	type: "boolean",
	default: true,
	ui: {
		label: "Show Resolved Model Badge",
		description: "Show which model a role actually resolved to, rather than the role name alone",
		tab: "appearance",
		group: "Display",
		control: "cycle",
	},
});
export const startupCheckUpdate = registerSetting({
	key: "startup.checkUpdate",
	type: "boolean",
	default: true,
	ui: {
		label: "Check for Updates",
		description:
			"Check on startup whether a newer version is published. Nothing is downloaded or installed either way",
		tab: "interaction",
		group: "Startup & Updates",
		control: "cycle",
	},
});

export const updateChannel = registerSetting({
	key: "update.channel",
	type: "enum",
	default: "stable",
	values: ["stable", "canary"],
	parse: (raw) => (raw === "stable" || raw === "canary" ? raw : undefined),
	ui: {
		label: "Update Channel",
		description: "Which stream to compare against: stable, or canary, which is expected to break",
		tab: "interaction",
		group: "Startup & Updates",
		control: "submenu",
	},
});

export const startupQuiet = registerSetting({
	key: "startup.quiet",
	type: "boolean",
	default: false,
	ui: {
		label: "Quiet Startup",
		description: "Start without the splash or the changelog",
		tab: "interaction",
		group: "Startup & Updates",
		control: "cycle",
	},
});

export const startupChangelogEnabled = registerSetting({
	key: "startup.changelogMode",
	type: "boolean",
	default: true,
	ui: {
		label: "Startup Changelog",
		description: "Show what changed since the version you last ran",
		tab: "interaction",
		group: "Startup & Updates",
		control: "cycle",
	},
});
export const askEnabled = registerSetting({
	key: "ask.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Ask",
		// Honest about what it does, because a user toggling this in `/settings`
		// otherwise sees a tool that does not exist. The validation layer in
		// `core/tools/ask.ts` is complete and tested, but no tool definition exists and
		// nothing outside that module's own test imports it.
		description: "Reserved: the ask tool is not implemented in PrimePi, so this setting currently has no effect",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});
export const securityEnabled = registerSetting({
	key: "security.enabled",
	type: "boolean",
	// Off by default. A failure to read this setting resolves to off as well, so a
	// broken settings read narrows access rather than widening it.
	default: false,
	ui: {
		label: "Security",
		// Says what is true today. The earlier text promised a security://
		// namespace and scan planning; neither exists in PrimePi (there is no
		// internal-urls layer and no scanner), so a user toggling this got
		// nothing and was not told so. Registered rather than removed, so the
		// parity panel still renders the row at its reference location.
		description:
			"Reserved: the security:// namespace and security scan planning are not implemented in PrimePi, so this setting currently has no effect",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});
export const providersCacheRetention = registerSetting({
	key: "providers.cacheRetention",
	type: "enum",
	default: "auto",
	values: ["auto", "short", "long", "none"],
	parse: (raw) => (raw === "auto" || raw === "short" || raw === "long" || raw === "none" ? raw : undefined),
	ui: {
		label: "Prompt Cache Retention",
		description:
			"Prompt-cache retention forwarded to providers that support it. Long entries cost more to write; auto lets the provider and PI_CACHE_RETENTION decide",
		tab: "providers",
		group: "Protocol",
		control: "submenu",
	},
});
export const providersOpenaiWebsockets = registerSetting({
	key: "providers.openaiWebsockets",
	type: "enum",
	default: "auto",
	values: ["auto", "off", "on"],
	parse: (raw) => (raw === "auto" || raw === "off" || raw === "on" ? raw : undefined),
	ui: {
		label: "OpenAI WebSockets",
		description: "Use the websocket transport for OpenAI where it is available",
		tab: "providers",
		group: "Protocol",
		control: "submenu",
	},
});

export const openrouterVariant = registerSetting({
	key: "providers.openrouterVariant",
	type: "enum",
	default: "default",
	values: ["default", "nitro", "floor", "online", "exacto"],
	parse: (raw) =>
		raw === "default" || raw === "nitro" || raw === "floor" || raw === "online" || raw === "exacto" ? raw : undefined,
	ui: {
		label: "OpenRouter Routing",
		description:
			"Routing-variant suffix appended to OpenRouter model ids. default sends no suffix; a model id that already names a variant is left alone",
		tab: "providers",
		group: "Protocol",
		control: "submenu",
	},
});
export const providersMaxInFlightRequests = registerSetting({
	key: "providers.maxInFlightRequests",
	type: "record",
	default: {},
	parse: (raw) =>
		typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, never>) : {},
	ui: {
		label: "Max In-Flight Requests",
		description:
			"Maximum concurrent LLM requests per provider id, shared across local processes with this config root. Omitted providers are unlimited.",
		tab: "providers",
		group: "Services",
	},
});
export const readSummarizeEnabled = registerSetting({
	key: "read.summarize.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Read Summaries",
		description: "Show a large file as signatures with the bodies elided, so the file can be read on demand",
		tab: "files",
		group: "Read Summaries",
		control: "cycle",
	},
});

export const readSummarizeProse = registerSetting({
	key: "read.summarize.prose",
	type: "boolean",
	default: false,
	ui: {
		label: "Prose Summaries",
		description: "Summarise Markdown and plain text too, which have no signatures and are usually worse summarised",
		tab: "files",
		group: "Read Summaries",
		control: "cycle",
	},
});

export const readSummarizeMinBodyLines = registerSetting({
	key: "read.summarize.minBodyLines",
	type: "number",
	default: 40,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Read Summary Body Lines",
		description: "Minimum body lines before a block is elided",
		tab: "files",
		group: "Read Summaries",
	},
});

export const readSummarizeMinCommentLines = registerSetting({
	key: "read.summarize.minCommentLines",
	type: "number",
	default: 20,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Read Summary Comment Lines",
		description: "Minimum comment lines before a block is elided",
		tab: "files",
		group: "Read Summaries",
	},
});

export const readSummarizeMinTotalLines = registerSetting({
	key: "read.summarize.minTotalLines",
	type: "number",
	default: 100,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Read Summary Minimum File Length",
		description: "Files with fewer total lines are read verbatim instead of structurally summarized",
		tab: "files",
		group: "Read Summaries",
	},
});

export const readSummarizeUnfoldUntil = registerSetting({
	key: "read.summarize.unfoldUntil",
	type: "number",
	default: 2000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Read Summary Unfold Target",
		description: "Unfold the elided middle until this many lines are shown",
		tab: "files",
		group: "Read Summaries",
	},
});

export const readSummarizeUnfoldLimit = registerSetting({
	key: "read.summarize.unfoldLimit",
	type: "number",
	default: 2000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Read Summary Unfold Ceiling",
		description: "Hard ceiling on how much unfolding may add",
		tab: "files",
		group: "Read Summaries",
	},
});
export const statusLinePreset = registerSetting({
	key: "statusLine.preset",
	type: "enum",
	default: "default",
	values: ["default", "compact", "custom"],
	parse: (raw) => (raw === "default" || raw === "compact" || raw === "custom" ? raw : undefined),
	ui: {
		label: "Status Line Preset",
		description: "Which set of segments the status line shows",
		tab: "appearance",
		group: "Status Line",
		control: "submenu",
	},
});

export const statusLineSeparator = registerSetting({
	key: "statusLine.separator",
	type: "enum",
	default: "pipe",
	values: ["pipe", "dot", "none"],
	parse: (raw) => (raw === "pipe" || raw === "dot" || raw === "none" ? raw : undefined),
	ui: {
		label: "Status Line Separator",
		description: "The glyph between status line segments",
		tab: "appearance",
		group: "Status Line",
		control: "submenu",
	},
});

export const statusLineContextLine = registerSetting({
	key: "statusLine.contextLine",
	type: "enum",
	default: "embedded",
	values: ["off", "percentage", "annotated", "embedded"],
	parse: (raw) =>
		raw === "off" || raw === "percentage" || raw === "annotated" || raw === "embedded" ? raw : undefined,
	ui: {
		label: "Context-Reactive Line",
		description:
			"How the line reflects context usage: off, a filled percentage, ticks at the speculative and auto-compaction boundaries, or the numbers embedded in the gauge",
		tab: "appearance",
		group: "Status Line",
		control: "submenu",
	},
});

export const statusLineSessionAccent = registerSetting({
	key: "statusLine.sessionAccent",
	type: "boolean",
	default: true,
	ui: {
		label: "Session Accent",
		description: "Use the session name color for the editor border and status line gap",
		tab: "appearance",
		group: "Status Line",
		control: "cycle",
	},
});

export const statusLineTransparent = registerSetting({
	key: "statusLine.transparent",
	type: "boolean",
	default: false,
	ui: {
		label: "Transparent Status Line",
		description: "Let the terminal background show through the status line",
		tab: "appearance",
		group: "Status Line",
		control: "cycle",
	},
});

export const statusLineCompactThinkingLevel = registerSetting({
	key: "statusLine.compactThinkingLevel",
	type: "boolean",
	default: false,
	ui: {
		label: "Compact Thinking Level",
		description: "Show the thinking level as a single glyph rather than a word",
		tab: "appearance",
		group: "Status Line",
		control: "cycle",
	},
});

export const statusLineShowHookStatus = registerSetting({
	key: "statusLine.showHookStatus",
	type: "boolean",
	default: false,
	ui: {
		label: "Show Hook Status",
		description: "Show whether a hook is installed and active",
		tab: "appearance",
		group: "Status Line",
		control: "cycle",
	},
});
export const mnemopiPolyphonicRecall = registerSetting({
	key: "mnemopi.polyphonicRecall",
	type: "boolean",
	default: false,
	ui: {
		label: "Mnemopi Polyphonic Recall",
		description:
			"Fuse four recall voices (vector, graph, fact, temporal) by reciprocal rank, so agreement across voices outweighs any single win",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});

export const mnemopiEnhancedRecall = registerSetting({
	key: "mnemopi.enhancedRecall",
	type: "boolean",
	default: false,
	ui: {
		label: "Mnemopi Enhanced Recall",
		description: "Widen each voice's candidate pool before the ranks are fused",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});

export const mnemopiProactiveLinking = registerSetting({
	key: "mnemopi.proactiveLinking",
	type: "boolean",
	default: false,
	ui: {
		label: "Mnemopi Proactive Linking",
		description: "Link related memories as they are stored rather than waiting for a recall to find the link",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});
export const astGrepEnabled = registerSetting({
	key: "astGrep.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "AST Grep",
		description: "Search by AST pattern rather than by text, so a match is a construct and not a substring",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const astEditEnabled = registerSetting({
	key: "astEdit.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "AST Edit",
		description: "Apply an edit as an AST transform, so a rename or signature change rewrites every call site",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const idaEnabled = registerSetting({
	key: "ida.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "IDA Pro",
		description: "Query a running IDA instance for decompiled structure",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const debugEnabled = registerSetting({
	key: "debug.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Debug",
		description: "Attach to a running process over DAP and inspect its frames",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const launchEnabled = registerSetting({
	key: "launch.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Services",
		description: "Start and stop the background services a session needs",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const vaultEnabled = registerSetting({
	key: "vault.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Obsidian Vault",
		description: "Search and write an Obsidian vault as a notes store",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});
export const providersOpenaiCodexCodeMode = registerSetting({
	key: "providers.openai-codex.codeMode",
	type: "enum",
	default: "off",
	values: ["off", "on", "auto"],
	parse: (raw) => (raw === "off" || raw === "on" || raw === "auto" ? raw : undefined),
	ui: {
		label: "Codex Code Mode",
		description:
			"Collapse the direct tool surface for code_mode_only models to a small keep-set, reaching every other tool through the eval bridge. auto follows the model catalog flag.",
		tab: "providers",
		group: "Services",
		control: "submenu",
	},
});

export const providersOpenaiCodexCodeModeDirectTools = registerSetting({
	key: "providers.openai-codex.codeModeDirectTools",
	type: "stringList",
	default: [],
	parse: (raw) => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : undefined),
	ui: {
		label: "Codex Code Mode Direct Tools",
		description:
			"Extra tools to keep on the direct surface under Code Mode. checkpoint, rewind and new_context are always kept, because the machinery that acts on them reads the direct tool result.",
		tab: "providers",
		group: "Services",
	},
});

export const providersWebSearchTimeoutSeconds = registerSetting({
	key: "providers.webSearchTimeoutSeconds",
	type: "number",
	default: 30,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Web Search Timeout",
		description: "Seconds to wait for a provider web search before falling back to the next route",
		tab: "providers",
		group: "Services",
	},
});
export const retryWaitForUsageReset = registerSetting({
	key: "retry.waitForUsageReset",
	type: "boolean",
	default: true,
	ui: {
		label: "Wait For Usage Reset",
		description:
			"Wait for a rate limit to reset instead of failing the turn, when the provider reports when the window resets",
		tab: "model",
		group: "Retry & Fallback",
		control: "cycle",
	},
});

export const retryUsageAwareFallback = registerSetting({
	key: "retry.usageAwareFallback",
	type: "boolean",
	default: false,
	ui: {
		label: "Usage-Aware Fallback",
		description:
			"Move to another model when the current coding plan is nearly spent, rather than waiting for it to reset",
		tab: "model",
		group: "Retry & Fallback",
		control: "cycle",
	},
});

export const retryUsageReservePct = registerSetting({
	key: "retry.usageReservePct",
	type: "number",
	default: 10,
	parse: (raw) =>
		typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.trunc(raw) : undefined,
	ui: {
		label: "Reserve Margin",
		description:
			"Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.",
		tab: "model",
		group: "Retry & Fallback",
	},
});

export const retryUsageReservePolicy = registerSetting({
	key: "retry.usageReservePolicy",
	type: "enum",
	default: "confirm",
	values: ["confirm", "auto", "fail-closed"],
	parse: (raw) => (raw === "confirm" || raw === "auto" || raw === "fail-closed" ? raw : undefined),
	ui: {
		label: "Reserve Policy",
		description:
			"What to do when every same-provider coding-plan account is inside the reserve margin. fail-closed refuses even when a healthy account exists, because switching would spend the margin while reporting a normal turn.",
		tab: "model",
		group: "Retry & Fallback",
		control: "submenu",
	},
});
export const modelLoopGuardEnabled = registerSetting({
	key: "model.loopGuard.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Loop Guard",
		description:
			"Terminate a stream that repeats itself instead of answering, so a degenerate reasoning loop does not burn the whole output budget",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});

export const modelLoopGuardCheckAssistantContent = registerSetting({
	key: "model.loopGuard.checkAssistantContent",
	type: "boolean",
	default: true,
	ui: {
		label: "Loop Guard Scan Prose",
		description: "Also scan visible assistant text for a repeated cycle, not only the reasoning stream",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});

export const modelLoopGuardToolCallReminder = registerSetting({
	key: "model.loopGuard.toolCallReminder",
	type: "boolean",
	default: true,
	ui: {
		label: "Loop Guard Tool-Call Reminder",
		description: "Remind the model to call a tool or answer when its reasoning has stopped making progress",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});
export const compactionMethodOrder = registerSetting({
	key: "compaction.methodOrder",
	type: "stringList",
	default: [...DEFAULT_COMPACTION_METHOD_ORDER],
	parse: (raw) => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : undefined),
	ui: {
		label: "Compaction Method Order",
		description:
			"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice",
		tab: "context",
		group: "Compaction",
	},
});

export const compactionMidTurnEnabled = registerSetting({
	key: "compaction.midTurnEnabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Mid-Turn Compaction",
		description: "Compact between tool calls when the context fills, rather than only before a user turn",
		tab: "context",
		group: "Compaction",
		control: "cycle",
	},
});

export const compactionHandoffSaveToDisk = registerSetting({
	key: "compaction.handoffSaveToDisk",
	type: "boolean",
	default: true,
	ui: {
		label: "Save Handoff Docs",
		description:
			"Write the handoff document to disk when handoff compaction runs, so the pre-compaction state stays recoverable",
		tab: "context",
		group: "Compaction",
		control: "cycle",
	},
});
export const evalPy = registerSetting({
	key: "eval.py",
	type: "boolean",
	default: true,
	ui: {
		label: "Python Eval Backend",
		description: "Run eval cells in the Python kernel",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});

export const evalJs = registerSetting({
	key: "eval.js",
	type: "boolean",
	default: true,
	ui: {
		label: "JavaScript Eval Backend",
		description: "Run eval cells in the JavaScript kernel",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});

export const evalAutoProvision = registerSetting({
	key: "eval.autoProvision",
	type: "boolean",
	default: true,
	ui: {
		label: "Eval Environment Provisioning",
		description: "Automatically create the managed JavaScript eval package environment on first install",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});

export const evalToolsEnabled = registerSetting({
	key: "eval.tools.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Eval-Defined Tools",
		description:
			"Let eval cells define tools that task, agent(), and workpool() subagents can call. Disabled sessions get an error naming this setting rather than an empty list.",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});

export const evalWorkpoolFreshAgents = registerSetting({
	key: "eval.workpool.freshAgents",
	type: "boolean",
	default: false,
	ui: {
		label: "Fresh Workpool Agents",
		description: "Give each workpool agent its own kernel state rather than sharing one",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});

export const evalAutoBackground = registerSetting({
	key: "eval.autoBackground.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Eval Auto-Background",
		description: "Move a long-running eval cell to the background instead of blocking the turn",
		tab: "shell",
		group: "Eval & Runtimes",
		control: "cycle",
	},
});
export const isolationBackend = registerSetting({
	key: "isolation.backend",
	type: "enum",
	default: "auto",
	values: ["auto", "apfs", "btrfs", "zfs", "reflink", "overlayfs", "projfs", "block-clone", "rcopy"],
	parse: (raw) =>
		raw === "auto" ||
		raw === "apfs" ||
		raw === "btrfs" ||
		raw === "zfs" ||
		raw === "reflink" ||
		raw === "overlayfs" ||
		raw === "projfs" ||
		raw === "block-clone" ||
		raw === "rcopy"
			? raw
			: undefined,
	ui: {
		label: "Isolation Backend",
		description:
			"Backend used for subagent isolation and worktree cloning. An unavailable choice falls back within its class first, and the result reports that it did.",
		tab: "tasks",
		group: "Isolation",
		control: "submenu",
	},
});

export const worktreeBase = registerSetting({
	key: "worktree.base",
	type: "string",
	default: "",
	ui: {
		label: "Worktree Base Directory",
		description: "Where worktrees are created; empty places them beside the repository",
		tab: "tasks",
		group: "Isolation",
	},
});

export const taskMaxRuntimeMs = registerSetting({
	key: "task.maxRuntimeMs",
	type: "number",
	default: 1_800_000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Max Subagent Runtime",
		description: "Milliseconds a subagent may run before it is stopped and its result returned",
		tab: "tasks",
		group: "Isolation",
	},
});

export const taskAgentIdleTtlMs = registerSetting({
	key: "task.agentIdleTtlMs",
	type: "number",
	default: 300_000,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Agent Idle TTL",
		description: "Milliseconds an idle subagent is kept before its process is released",
		tab: "tasks",
		group: "Isolation",
	},
});
/**
 * Whether the animated startup splash runs on an ordinary interactive launch.
 *
 * Defaults to **false**, matching the reference: `startup.showSplash` is `default: false`
 * there, because the reference's splash is phase 0 of the setup wizard, and the wizard is
 * what a first run gets. Running the animation on *every* launch is Prime Pi's choice and
 * it was the wrong one - it spends 2.6s of every session on decoration.
 *
 * First run still shows it regardless, because that is the wizard's phase 0 and the whole
 * point of the onboarding experience. This setting only governs the repeat case.
 */
export const startupShowSplash = registerSetting({
	key: "startup.showSplash",
	type: "boolean",
	default: false,
	ui: {
		label: "Show Startup Splash",
		description:
			"Show the full animated splash on normal interactive startup. First-run onboarding shows it either way, since it is the first scene of the wizard",
		tab: "appearance",
		group: "Startup",
	},
});

export const themeDark = registerSetting({
	key: "theme.dark",
	type: "string",
	default: "titanium",
	ui: {
		label: "Dark Theme",
		description: "Theme applied when the terminal reports a dark background",
		tab: "appearance",
		group: "Theme",
	},
});

export const themeLight = registerSetting({
	key: "theme.light",
	type: "string",
	default: "light",
	ui: {
		label: "Light Theme",
		description: "Theme applied when the terminal reports a light background",
		tab: "appearance",
		group: "Theme",
	},
});

export const colorBlindMode = registerSetting({
	key: "colorBlindMode",
	type: "boolean",
	default: false,
	ui: {
		label: "Color-Blind Mode",
		description:
			"Rotate the diff addition colour out of the red-green confusion region, keeping its lightness and chroma so the theme's contrast still holds",
		tab: "appearance",
		group: "Theme",
		control: "cycle",
	},
});

/**
 * How far onboarding has progressed.
 *
 * Version-gated rather than a boolean, so a *later* release can add or revise a scene and
 * have only the new work appear for a user who already finished onboarding - matching the
 * reference, where `CURRENT_SETUP_VERSION` is `max(scene.minVersion)` across the scene list.
 *
 * 0 means never completed. There is deliberately no "settings.json exists" substitute: a
 * user who interrupts onboarding still has a settings file, and treating its presence as
 * completion would silently strand them mid-wizard with no way back in.
 */
export const setupVersion = registerSetting({
	key: "setup.version",
	type: "number",
	default: 0,
	// No `ui` block: this is progress state, not a preference. A setting with no `ui` is
	// config-file only and never appears in the picker, so there is no dead control for a user
	// to change and desynchronise from the wizard.
});

/**
 * Whether first-run onboarding may run.
 *
 * Defaults to true, matching the reference's `startup.setupWizard`. The opt-out is
 * `PI_SKIP_SETUP`; this is the settings-panel equivalent for someone who wants the gate to
 * read from configuration rather than the environment.
 */
export const startupSetupWizard = registerSetting({
	key: "startup.setupWizard",
	type: "boolean",
	default: true,
	ui: {
		label: "Run Setup Wizard",
		description:
			"Run first-run onboarding on an incomplete setup. Unsaved onboarding is resumable; PI_SKIP_SETUP suppresses it entirely",
		tab: "interaction",
		group: "Startup & Updates",
	},
});

export const symbolPreset = registerSetting({
	key: "symbolPreset",
	type: "enum",
	default: "default",
	values: ["default", "minimal", "ascii", "nerd"],
	parse: (raw) => (raw === "default" || raw === "minimal" || raw === "ascii" || raw === "nerd" ? raw : undefined),
	ui: {
		label: "Symbol Preset",
		description: "Which glyph set the status line and borders use",
		tab: "appearance",
		group: "Theme",
		control: "submenu",
	},
});

export const composerShape = registerSetting({
	key: "composer.shape",
	type: "string",
	// `box`, not `rounded`: the composer registry's ids are box / band / claude / pi /
	// borderless / rule / field / rail. A default outside that set resolved to nothing.
	default: "box",
	ui: {
		label: "Composer Shape",
		description: "Border shape drawn around the composer",
		tab: "appearance",
		group: "Theme",
	},
});

export const composerTokenRate = registerSetting({
	key: "composer.tokenRate",
	type: "boolean",
	default: true,
	ui: {
		label: "Generation Rate",
		description: "Show tokens per second while the model is streaming",
		tab: "appearance",
		group: "Theme",
		control: "cycle",
	},
});

export const tuiTextSizing = registerSetting({
	key: "tui.textSizing",
	type: "boolean",
	default: false,
	ui: {
		label: "Large Headings (Kitty)",
		description: "Draw headings at a larger size, on terminals that support it",
		tab: "appearance",
		group: "Theme",
		control: "cycle",
	},
});

export const tuiRenderMermaid = registerSetting({
	key: "tui.renderMermaid",
	type: "boolean",
	default: false,
	ui: {
		label: "Render Mermaid Diagrams",
		description: "Render a mermaid block as a diagram where the terminal supports images",
		tab: "appearance",
		group: "Theme",
		control: "cycle",
	},
});

export const displayShimmer = registerSetting({
	key: "display.shimmer",
	type: "enum",
	default: "auto",
	values: ["off", "auto", "always"],
	parse: (raw) => (raw === "off" || raw === "auto" || raw === "always" ? raw : undefined),
	ui: {
		label: "Shimmer",
		description: "Animate the busy indicator while the model is working",
		tab: "appearance",
		group: "Theme",
		control: "submenu",
	},
});
export const composerRecallClearedDrafts = registerSetting({
	key: "composer.recallClearedDrafts",
	type: "boolean",
	// On by default: a clear that throws away a half-written thought should be
	// recoverable, and forgetting it silently is the worse failure.
	default: true,
	ui: {
		label: "Recall Cleared Drafts",
		description: "Keep drafts cleared with ctrl+c in local history until exit; disabling affects future clears",
		tab: "interaction",
		group: "Input",
		control: "cycle",
	},
});

export const loopMode = registerSetting({
	key: "loop.mode",
	type: "enum",
	// Prompt is the default: re-submitting is the least destructive option and
	// the one that changes nothing about the session the user is already in.
	default: "prompt",
	values: ["prompt", "compact", "reset"],
	parse: (raw) => (raw === "prompt" || raw === "compact" || raw === "reset" ? raw : undefined),
	ui: {
		label: "Loop Mode",
		description: "What happens between /loop iterations before re-submitting the prompt",
		tab: "interaction",
		group: "Input",
		control: "submenu",
	},
});

export const loopConditionTimeout = registerSetting({
	key: "loop.conditionTimeoutMs",
	type: "number",
	default: 30_000,
	// 0 disables the bound, which is a deliberate choice: a condition that
	// legitimately takes minutes exists, and a user who wants that should say so.
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined),
	ui: {
		label: "Loop Condition Timeout (ms)",
		description:
			"Max wait for a /loop --while or --until condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely",
		tab: "interaction",
		group: "Input",
	},
});

export const interruptMode = registerSetting({
	key: "interruptMode",
	type: "enum",
	// Immediate is the default because it honours the user rather than stalling
	// them; `wait` exists for work that must not be abandoned halfway.
	default: "immediate",
	values: ["immediate", "wait"],
	parse: (raw) => (raw === "immediate" || raw === "wait" ? raw : undefined),
	ui: {
		label: "Interrupt Mode",
		description: "When steering messages interrupt tool execution",
		tab: "interaction",
		group: "Input",
		control: "submenu",
	},
});

export const todoEnabled = registerSetting({
	key: "todo.enabled",
	type: "boolean",
	default: true,
	ui: {
		label: "Todos",
		description: "Track multi-step work as durable phases that survive a resume, rewind or fork",
		tab: "tools",
		group: "Available Tools",
		control: "cycle",
	},
});

export const defaultThinkingLevel = registerSetting({
	key: "defaultThinkingLevel",
	type: "enum",
	// `auto` is the default and is deliberately not a level: it means "let the
	// model or role decide", and the request layer sends no reasoning parameter.
	default: "auto",
	values: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
	parse: (raw) =>
		typeof raw === "string" && parseConfiguredThinkingLevel(raw) ? parseConfiguredThinkingLevel(raw) : undefined,
	ui: {
		label: "Thinking Level",
		description: "Default reasoning effort, clamped down to what the active model supports",
		tab: "model",
		group: "Thinking",
		control: "submenu",
	},
});

export const streamFirstEventTimeout = registerSetting({
	key: "providers.streamFirstEventTimeoutSeconds",
	type: "number",
	// -1 means auto: use the provider default or the environment, rather than a
	// constant that would override whatever the provider or operator configured.
	// 0 disables the watchdog entirely; it does not mean an instant abort.
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : -1),
	ui: {
		label: "Stream First Event Timeout",
		description:
			"Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog",
		tab: "providers",
		group: "Timeouts",
	},
});

export const streamIdleTimeout = registerSetting({
	key: "providers.streamIdleTimeoutSeconds",
	type: "number",
	default: -1,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? raw : -1),
	ui: {
		label: "Stream Idle Timeout",
		description:
			"Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog",
		tab: "providers",
		group: "Timeouts",
	},
});

export const secretsRedactionEnabled = registerSetting({
	key: "secrets.enabled",
	type: "boolean",
	default: true,
});

/**
 * Redact recognized credentials from tool arguments before they are shown.
 *
 * Separate from `secrets.enabled` because a caller may want provider-bound
 * redaction without losing argument fidelity in the local UI.
 */
export const secretsRedactToolArguments = registerSetting({
	key: "secrets.redactToolArguments",
	type: "boolean",
	default: true,
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

/**
 * The Memory tab, transcribed from the OMP reference.
 *
 * `memory.backend` is the selector the panel opens; its option list and
 * descriptions live in `core/memory/registry.ts`, which keeps the OMP ordering
 * in one place. The remaining rows carry `unavailable`, because their runtimes
 * are not migrated: they render as disabled markers at their reference
 * locations and activate in place when the runtime lands.
 */
export const memoryBackend = registerSetting({
	key: "memory.backend",
	type: "enum",
	default: "off",
	values: ["off", "local", "hindsight", "mnemopi", "sharpshooter"],
	parse: (raw) => (typeof raw === "string" ? raw : undefined),
	ui: {
		label: "Memory Backend",
		description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
		tab: "memory",
		group: "General",
		control: "submenu",
	},
});

// The three settings the per-project bank store consumes. They sit in the
// reference's `mnemopi` group rather than a PrimePi group of their own, so the
// settings panel structure does not shift when they activate. The remaining
// `mnemopi.*` rows stay unmigrated: the embedding subsystem is a separate
// capability with its own failure modes, and claiming those rows would claim
// something nothing reads.
export const bankStorePath = registerSetting({
	key: "mnemopi.dbPath",
	type: "string",
	// Empty means unset. The reference models this as an optional string, but a
	//  cannot be undefined, and an empty default parses back to the
	// same absence - so no consumer has to special-case a sentinel.
	default: "",
	parse: (raw) => (typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : ""),
	ui: {
		label: "Mnemopi DB Path",
		description: "Optional SQLite DB path. Defaults to the agent memories directory.",
		tab: "memory",
		group: "Mnemopi",
	},
});

export const bankStoreName = registerSetting({
	key: "mnemopi.bank",
	type: "string",
	default: "",
	parse: (raw) => (typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : ""),
	ui: {
		label: "Mnemopi Bank",
		description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
		tab: "memory",
		group: "Mnemopi",
	},
});

export const bankStoreScoping = registerSetting({
	key: "mnemopi.scoping",
	type: "enum",
	default: "per-project",
	values: ["global", "per-project", "per-project-tagged"],
	parse: (raw) => {
		if (raw !== "global" && raw !== "per-project" && raw !== "per-project-tagged") return undefined;
		return raw;
	},
	ui: {
		label: "Mnemopi Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per project path; per-project-tagged = project-local writes plus shared recall visibility",
		tab: "memory",
		group: "Mnemopi",
		control: "submenu",
	},
});

export const retryMaxRetries = registerSetting({
	key: "retry.maxRetries",
	type: "number",
	// The documented default (`docs/settings.md`) and the value the session has
	// always used. It was `0` here, which matched neither: any consumer trusting
	// the descriptor would silently disable every retry. OMP ships 10, which this
	// fork deliberately narrows — raising the budget is a spend decision, not a
	// wiring fix.
	default: 3,
	ui: {
		label: "Max Retries",
		description: "Number of automatic retries before the turn is abandoned",
		tab: "model",
		group: "Retry & Fallback",
	},
});

export const retryMaxDelayMs = registerSetting({
	key: "retry.maxDelayMs",
	type: "number",
	default: 0,
	ui: {
		label: "Max Retry Delay",
		description: "Upper bound on the backoff between retries, in milliseconds",
		tab: "model",
		group: "Retry & Fallback",
	},
});

export const retryModelFallback = registerSetting({
	key: "retry.modelFallback",
	type: "boolean",
	default: true,
	ui: {
		label: "Model Fallback",
		description: "Route a failed turn to a healthy model instead of failing it",
		tab: "model",
		group: "Retry & Fallback",
		control: "cycle",
	},
});

export const retryFallbackRevertPolicy = registerSetting({
	key: "retry.fallbackRevertPolicy",
	type: "enum",
	default: "cooldown-expiry",
	values: ["never", "cooldown-expiry"],
	parse: (raw) => (raw === "never" || raw === "cooldown-expiry" ? raw : undefined),
	ui: {
		label: "Fallback Revert Policy",
		description: "When to return to the primary model once it recovers",
		tab: "model",
		group: "Retry & Fallback",
		control: "submenu",
	},
});

export const toolCallLoopGuardEnabled = registerSetting({
	key: "model.toolCallLoopGuard.enabled",
	type: "boolean",
	// Off by default: a guard that fires wrongly gets disabled, and a disabled guard
	// protects nothing. The user opts in to the correction being injected.
	default: false,
	ui: {
		label: "Tool-Call Loop Guard",
		description: "Detect a model reissuing the same tool call and steer it away",
		tab: "model",
		group: "Thinking",
		control: "cycle",
	},
});

export const toolCallLoopGuardThreshold = registerSetting({
	key: "model.toolCallLoopGuard.threshold",
	type: "number",
	default: 3,
	parse: (raw) => (typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : undefined),
	ui: {
		label: "Tool-Call Loop Threshold",
		description: "Identical consecutive turns before the guard intervenes",
		tab: "model",
		group: "Thinking",
	},
});

export const toolCallLoopGuardExemptTools = registerSetting({
	key: "model.toolCallLoopGuard.exemptTools",
	type: "stringList",
	default: [],
	ui: {
		label: "Tool-Call Loop Exempt Tools",
		description: "Tools that are expected to be called repeatedly and are not counted as a loop",
		tab: "model",
		group: "Thinking",
	},
});

export const editRecoverInlineEdits = registerSetting({
	key: "edit.recoverInlineEdits",
	type: "boolean",
	default: true,
	ui: {
		label: "Recover Inline Edits",
		description: "Re-materialise an edit payload the model emitted as plain text as an edit tool call",
		tab: "files",
		group: "Editing",
		control: "cycle",
	},
});

export const autoResume = registerSetting({
	key: "autoResume",
	type: "boolean",
	// Off by default, as in the reference. Auto-resume changes which conversation
	// a launch opens, and a user who has not asked for that should never get it.
	default: false,
	ui: {
		label: "Auto Resume",
		description: "Automatically resume the most recent session in the current directory",
		tab: "interaction",
		group: "Startup & Updates",
		control: "cycle",
	},
});

export const compactionSupersedeReads = registerSetting({
	key: "compaction.supersedeReads",
	type: "boolean",
	default: true,
	ui: {
		label: "Supersede Stale Reads",
		description: "Replace a tool result that a newer read of the same target has made redundant",
		tab: "context",
		group: "Compaction",
		control: "cycle",
	},
});

export const compactionDropUseless = registerSetting({
	key: "compaction.dropUseless",
	type: "boolean",
	default: true,
	ui: {
		label: "Elide Uneventful Results",
		description: "Replace a tool result that carries no information with a short notice",
		tab: "context",
		group: "Compaction",
		control: "cycle",
	},
});

export const bankStoreAutoRecall = registerSetting({
	key: "mnemopi.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		label: "Mnemopi Auto Recall",
		description: "Recall local memories into the first turn of each session",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});

export const bankStoreAutoRetain = registerSetting({
	key: "mnemopi.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		label: "Mnemopi Auto Retain",
		description: "Retain completed conversation turns into local Mnemopi memory",
		tab: "memory",
		group: "Mnemopi",
		control: "cycle",
	},
});

export const autolearnEnabled = registerSetting({
	key: "autolearn.enabled",
	type: "boolean",
	default: false,
	ui: {
		label: "Auto-Learn (experimental)",
		description: "Capture durable engineering experience at stop",
		tab: "memory",
		group: "Auto-Learn",
		control: "cycle",
		unavailable: "Auto-Learn runtime is not migrated into PrimePi",
	},
});

export const autolearnAutoContinue = registerSetting({
	key: "autolearn.autoContinue",
	type: "boolean",
	default: false,
	ui: {
		label: "Auto-run capture at stop",
		tab: "memory",
		group: "Auto-Learn",
		control: "cycle",
		unavailable: "Depends on the Auto-Learn runtime",
	},
});

export const sharpshooterModel = registerSetting({
	key: "sharpshooter.model",
	type: "string",
	default: "",
	ui: {
		label: "Sharpshooter Model",
		description: "Model selector for extraction/consolidation, empty = smol role",
		tab: "memory",
		group: "Sharpshooter",
		control: "submenu",
		unavailable: "Sharpshooter extraction/consolidation runtime is not migrated into PrimePi",
	},
});
