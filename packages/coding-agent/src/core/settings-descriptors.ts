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

// --- Secrets -----------------------------------------------------------------

/**
 * Whether recognized credentials are redacted before content leaves the machine.
 *
 * Defaults to on: the failure mode of leaving it off is silently shipping a
 * credential to a provider, and the failure mode of leaving it on is a
 * placeholder in a transcript, which is visible and recoverable.
 */
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
	default: 0,
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
