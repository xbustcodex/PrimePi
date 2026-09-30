import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type FailoverPolicy,
	type Model,
	type ResolvedCompactionLimits,
	resolveCompactionLimits,
	type Transport,
} from "@earendil-works/pi-ai";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar, TerminalCapabilities } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { type RetryPolicyResolution, resolveRetryPolicy } from "./retry-policy.ts";
import { CACHE_WARMING_MODES } from "./settings-descriptors.ts";
import {
	allSettings,
	hasPath,
	lookupSetting,
	type ResolvedSetting,
	readPath,
	type SettingHandle,
	type SettingSource,
	type SettingValue,
	writePath,
} from "./settings-registry.ts";

export { CACHE_WARMING_MODES } from "./settings-descriptors.ts";

export interface CompactionModelOverride {
	reserveTokens?: number;
	keepRecentTokens?: number;
}

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	modelOverrides?: Record<string, CompactionModelOverride>; // exact "provider/modelId" keys
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	maxAgentDelayMs?: number; // default: 60000
	provider?: ProviderRetrySettings;
}

export type TuiMode = RendererTuiMode;
export type FullscreenExitOutput = "transcript" | "resume-hint";

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
	imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	hyperlinks?: boolean | "auto";
	images?: "kitty" | "iterm2" | "auto" | false;
	trueColor?: boolean | "auto";
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

/** Cache-warming profile. "idle" also warms between agent runs. */
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // per-model default thinking level overrides keyed by "provider/modelId"
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	/**
	 * Automatic model failover policy. Defaults to "free-only", which recovers a free
	 * route but can never select a paid model. "compatible" may spend money and must
	 * be set explicitly.
	 */
	failover?: FailoverPolicy;
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // default: false - show cache cost and provider recovery notices
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	defaultTools?: string[]; // Initial built-in tool selection
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	cacheWarming?: CacheWarmingMode; // default: "streaming"; global only because each refresh costs money
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
	fullscreenCopyOnSelect?: boolean; // default: true; no effect in regular TUI mode
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

/**
 * Notified with a setting key and its newly effective value.
 *
 * The key is the dotted descriptor id, and the value is what `getSetting` would
 * now return, not the raw value that was written. A write to a layer that is
 * shadowed by a higher layer produces no notification at all.
 */
export type EffectiveChangeListener = (key: string, value: SettingValue) => void;

interface EffectiveChangeWatch {
	keys: Set<string>;
	disposed: boolean;
}

/**
 * Stable serialization for comparing setting values.
 *
 * Object keys are sorted so a record rewritten with identical membership
 * compares equal regardless of insertion order, while added or removed entries
 * still register as a change.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/**
 * Identity for a listener, used to key its snapshot rows.
 *
 * Listeners are function values, so a `WeakMap` assigns each one a stable id
 * without retaining it past unsubscribe.
 */
const listenerIds = new WeakMap<EffectiveChangeListener, string>();
let nextListenerId = 0;

function listenerId(listener: EffectiveChangeListener): string {
	let id = listenerIds.get(listener);
	if (id === undefined) {
		id = `l${++nextListenerId}`;
		listenerIds.set(listener, id);
	}
	return id;
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings!: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;
	/**
	 * Bumped whenever any layer changes. Derived setting reads are memoized against
	 * it so a consumer can read a setting in a hot loop without re-walking the layers.
	 */
	private revision = 0;
	/** Top-level keys supplied by `applyOverrides`, used only to report provenance. */
	private overrideKeys = new Set<string>();
	/**
	 * The override values themselves, kept so `recomputeMerged` can re-apply them
	 * after a layer write rebuilds the merged view from the persisted layers.
	 */
	private storedOverrides: Settings = {};
	private resolvedCache = new Map<string, { revision: number; resolved: ResolvedSetting }>();
	/**
	 * Subscribers to effective-value changes, grouped by the setting keys they
	 * asked about. `"*"` means every registered setting.
	 */
	private effectiveChangeListeners = new Map<EffectiveChangeListener, EffectiveChangeWatch>();
	/**
	 * Last observed effective value per watched key, used to decide whether a
	 * layer mutation actually changed anything a consumer can observe.
	 *
	 * This is what makes a notification about *effective* values rather than
	 * writes: a project-layer write hidden behind an override leaves the snapshot
	 * untouched, so nothing is announced, and dropping that override reveals a
	 * different value, so that *is* announced.
	 */
	private effectiveValueSnapshot = new Map<string, string>();

	/**
	 * Notifies when the effective value of a setting changes.
	 *
	 * `keys` selects what to watch; omit it (or pass `["*"]`) to watch every
	 * registered setting. Returns an unsubscribe function, and calling it more
	 * than once is a no-op, so a long-lived session can dispose defensively.
	 */
	onEffectiveChange(keys: readonly string[] | undefined, listener: EffectiveChangeListener): () => void {
		const watch: EffectiveChangeWatch = {
			keys: new Set(keys && keys.length > 0 ? keys : ["*"]),
			disposed: false,
		};
		this.effectiveChangeListeners.set(listener, watch);
		// Seed from the current effective values so the first call after
		// subscribing reports only subsequent changes.
		for (const key of this.watchedKeys(watch)) {
			this.effectiveValueSnapshot.set(this.snapshotKey(listener, key), this.effectiveSignature(key));
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.disposeEffectiveChangeListener(listener);
		};
	}

	/** Number of live subscribers. Diagnostics and leak tests. */
	getEffectiveChangeListenerCount(): number {
		return this.effectiveChangeListeners.size;
	}

	private watchedKeys(watch: EffectiveChangeWatch): readonly string[] {
		if (watch.keys.has("*")) return allSettings().map((handle) => handle.id);
		return [...watch.keys].filter((key) => lookupSetting(key) !== undefined);
	}

	private snapshotKey(listener: EffectiveChangeListener, key: string): string {
		return `${listenerId(listener)}\u0000${key}`;
	}

	private disposeEffectiveChangeListener(listener: EffectiveChangeListener): void {
		const watch = this.effectiveChangeListeners.get(listener);
		if (!watch) return;
		watch.disposed = true;
		this.effectiveChangeListeners.delete(listener);
		for (const key of watch.keys) {
			this.effectiveValueSnapshot.delete(this.snapshotKey(listener, key));
		}
	}

	/**
	 * A stable string for a setting's current effective value.
	 *
	 * Object values are serialized in sorted key order so a record whose entries
	 * were rewritten identically compares equal, while a record whose membership
	 * changed does not.
	 */
	private effectiveSignature(key: string): string {
		const resolved = this.getSetting(key);
		if (!resolved) return "\u0000absent";
		return `${resolved.source}\u0001${resolved.isExplicit ? "1" : "0"}\u0001${stableStringify(resolved.value)}`;
	}

	/**
	 * Compares watched effective values and announces the ones that moved.
	 *
	 * Called after the merged view changes, so it observes the same revision the
	 * memoized `getSetting` reads do. Listeners are invoked outside the map
	 * mutation so one unsubscribing during dispatch cannot corrupt the walk, and a
	 * throwing listener cannot prevent the others from running.
	 */
	private emitEffectiveChanges(): void {
		if (this.effectiveChangeListeners.size === 0) return;

		const announcements: { listener: EffectiveChangeListener; key: string; value: SettingValue }[] = [];
		for (const [listener, watch] of this.effectiveChangeListeners) {
			if (watch.disposed) continue;
			for (const key of this.watchedKeys(watch)) {
				const snapshotKey = this.snapshotKey(listener, key);
				const signature = this.effectiveSignature(key);
				if (this.effectiveValueSnapshot.get(snapshotKey) === signature) continue;
				this.effectiveValueSnapshot.set(snapshotKey, signature);
				announcements.push({ listener, key, value: this.getSetting(key)?.value as SettingValue });
			}
		}

		if (announcements.length === 0) return;
		for (const { listener, key, value } of announcements) {
			// Re-check: an earlier listener in this batch may have disposed this one.
			if (!this.effectiveChangeListeners.has(listener)) continue;
			try {
				listener(key, value);
			} catch {
				// A subscriber must not be able to break the settings layer or the
				// mutation that triggered it.
			}
		}
	}

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.recomputeMerged();
	}

	/**
	 * Rebuilds the merged view and invalidates every memoized setting read.
	 *
	 * Centralized so no layer mutation can change a layer without also invalidating
	 * the reads derived from it, and so effective-value notifications are emitted
	 * from exactly one place.
	 */
	private recomputeMerged(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
		// Overrides are recorded as top-level keys but stored folded into the merged
		// view, so a rebuild has to re-apply them. Without this, any later layer write
		// silently drops every override, which is how a caller-supplied override ends
		// up undone by an unrelated settings change.
		if (this.overrideKeys.size > 0) {
			this.settings = deepMergeSettings(this.settings, this.storedOverrides);
		}
		this.revision++;
		this.emitEffectiveChanges();
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// `retry.maxDelayMs` is a live registered setting (it caps the wait before a
		// retry and before a provider-reported usage reset is waited out). It used to
		// be deleted here on load and rerouted to `retry.provider.maxRetryDelayMs`,
		// which is neither registered nor read anywhere in the repo, so the move left
		// the setting impossible to configure and had no consumer at the destination.

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.recomputeMerged();
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.recomputeMerged();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.recomputeMerged();
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		// Retained so a later rebuild of the merged view does not silently drop them.
		this.storedOverrides = deepMergeSettings(this.storedOverrides, overrides);
		this.settings = deepMergeSettings(this.settings, overrides);
		// Recorded so a layered read can report `override` as the source. The merge
		// itself is unchanged: overrides still accumulate onto the merged view.
		for (const key of Object.keys(overrides)) {
			this.overrideKeys.add(key);
		}
		this.revision++;
		this.emitEffectiveChanges();
	}

	/** Bumped whenever any layer changes; memoized reads compare against it. */
	getRevision(): number {
		return this.revision;
	}

	/**
	 * Resolves a registered setting across the layers, reporting which layer won.
	 *
	 * Precedence: override, then project, then global, then environment fallback,
	 * then the descriptor default. A `globalOnly` descriptor skips the project layer
	 * because the setting is global by design.
	 */
	getSetting<T extends SettingValue>(key: string): ResolvedSetting<T> | undefined {
		const handle = lookupSetting(key);
		if (!handle) return undefined;

		const cached = this.resolvedCache.get(key);
		if (cached && cached.revision === this.revision) {
			return cached.resolved as ResolvedSetting<T>;
		}

		const resolved = this.resolveSetting(handle) as ResolvedSetting;
		this.resolvedCache.set(key, { revision: this.revision, resolved });
		return resolved as ResolvedSetting<T>;
	}

	private resolveSetting(handle: SettingHandle): ResolvedSetting {
		const { id, descriptor } = handle;
		const root = id.split(".")[0];

		const layers: { source: SettingSource; container: unknown }[] = [];
		if (this.overrideKeys.has(root)) {
			layers.push({ source: "override", container: this.settings });
		}
		if (!descriptor.globalOnly) {
			layers.push({ source: "project", container: this.projectSettings });
		}
		layers.push({ source: "global", container: this.globalSettings });

		for (const layer of layers) {
			const raw = readPath(layer.container, id);
			if (raw === undefined) continue;
			// A malformed persisted value falls through to the next layer rather than
			// throwing, matching the existing getters' lenient reads.
			try {
				return { value: handle.parse(raw), source: layer.source, isExplicit: true };
			} catch {}
		}

		if (descriptor.env) {
			const raw = process.env[descriptor.env];
			if (raw !== undefined) {
				const parsed = descriptor.parseEnv?.(raw);
				if (parsed !== undefined) {
					return { value: parsed as SettingValue, source: "default", isExplicit: false };
				}
			}
		}

		return { value: descriptor.default, source: "default", isExplicit: false };
	}

	/**
	 * Validates and writes a registered setting.
	 *
	 * Validation happens before any mutation so a bad value cannot reach the file.
	 * The write then reuses the existing field-scoped persistence and trust gates by
	 * delegating to the same helper the typed setters use.
	 */
	setSetting(key: string, value: unknown, scope: SettingsScope = "global"): void {
		const handle = lookupSetting(key);
		if (!handle) {
			throw new Error(`Unknown setting: ${key}`);
		}
		const parsed = handle.parse(value);
		if (scope === "project") {
			this.assertProjectTrustedForWrite();
			const projectSettings = structuredClone(this.projectSettings);
			writePath(projectSettings as Record<string, unknown>, key, parsed);
			this.markProjectModified(key.split(".")[0] as keyof Settings);
			this.saveProjectSettings(projectSettings);
			return;
		}
		writePath(this.globalSettings as Record<string, unknown>, key, parsed);
		this.markModified(key.split(".")[0] as keyof Settings);
		this.save();
	}

	/**
	 * Per-role model preferences, e.g. `{ smol: "@tiny, xai/grok-4.5" }`.
	 *
	 * Read through the registry so the value is validated like any other setting.
	 * Returns a fresh copy so a caller cannot mutate the merged view.
	 */
	getModelRoles(): Record<string, string> {
		const resolved = this.getSetting("modelRoles");
		const value = resolved?.value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return { ...(value as Record<string, string>) };
	}

	/** Assigns a role's model preference. Pass `undefined` to clear it. */
	setModelRole(role: string, value: string | undefined): void {
		const roles = this.getModelRoles();
		if (value === undefined) {
			delete roles[role];
		} else {
			roles[role] = value;
		}
		this.setSetting("modelRoles", roles, "global");
	}

	/**
	 * Reads a flat `stringList` setting as a fresh array.
	 *
	 * Returns a copy so a caller cannot mutate the merged view, and normalizes a
	 * malformed persisted value to an empty list rather than throwing, matching the
	 * lenient reads the rest of the layer performs.
	 */
	private getStringList(key: string): readonly string[] {
		const value = this.getSetting(key)?.value;
		if (!Array.isArray(value)) return [];
		return value.filter((entry): entry is string => typeof entry === "string");
	}

	/**
	 * Reads a `stringListMap` setting as a fresh role-keyed map of string lists.
	 */
	private getStringListMap(key: string): Record<string, string[]> {
		const value = this.getSetting(key)?.value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const result: Record<string, string[]> = {};
		for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
			if (Array.isArray(entryValue)) {
				result[entryKey] = entryValue.filter((item): item is string => typeof item === "string");
			}
		}
		return result;
	}

	/**
	 * Provider ids excluded from the pool.
	 *
	 * A `Set`, because the test is membership and runs per candidate. This is a
	 * hard filter: a disabled provider cannot re-enter through a role alias or a
	 * fallback chain.
	 */
	getDisabledProviders(): ReadonlySet<string> {
		return new Set(this.getStringList("disabledProviders"));
	}

	/**
	 * Model selectors that are allowed. Empty means no allowlist, which is a
	 * different state from an allowlist that matches nothing.
	 */
	getEnabledModelPatterns(): readonly string[] {
		return this.getStringList("enabledModels");
	}

	/**
	 * Provider preference order.
	 *
	 * A ranking hint only. It can promote one reachable provider over another and
	 * can never resurrect a candidate that failed an access, credential, policy, or
	 * cooldown check.
	 */
	getModelProviderOrder(): readonly string[] {
		return this.getStringList("modelProviderOrder");
	}

	/** Whether a role assignment is written to the global or project layer. */
	getModelRoleStorage(): "global" | "project" {
		return this.getSetting("modelRoleStorage")?.value === "project" ? "project" : "global";
	}

	/**
	 * Fallback candidate lists per role, e.g. `{ smol: ["@tiny", "xai/grok-4.5"] }`.
	 *
	 * Ordering data, not a retry policy. A configured list replaces the built-in
	 * chain for that role so a user can narrow it deliberately, and every entry in
	 * it still passes the same eligibility gates as the role's own preferences.
	 */
	getRetryFallbackChains(): Record<string, string[]> {
		return this.getStringListMap("retry.fallbackChains");
	}

	/** Fallback candidates configured for one role, or undefined when unset. */
	getRetryFallbackChain(role: string): readonly string[] | undefined {
		return this.getStringListMap("retry.fallbackChains")[role];
	}

	/** True when the setting declares at least one path, in any layer. */
	hasSettingInScope(key: string, scope: SettingsScope): boolean {
		const container = scope === "project" ? this.projectSettings : this.globalSettings;
		return hasPath(container, key);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.recomputeMerged();

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.recomputeMerged();

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.globalSettings.modelThinkingLevels) {
			this.globalSettings.modelThinkingLevels = {};
		}
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.settings.compaction;
		const ordinary = compaction?.[field];
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		const override = entry?.[field];
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
		};
	}

	/**
	 * Which tool-result pruning rules apply.
	 *
	 * Read through the registry so a mid-session change takes effect on the next
	 * turn. Both default to enabled; turning both off disables the pass entirely
	 * rather than leaving a no-op prune running every turn.
	 */
	getToolResultPruneSettings(): {
		supersedeReads: boolean;
		dropUseless: boolean;
	} {
		return {
			supersedeReads: this.getSetting("compaction.supersedeReads")?.value !== false,
			dropUseless: this.getSetting("compaction.dropUseless")?.value !== false,
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	/**
	 * The retry policy for the next request.
	 *
	 * Read through the registry so `retry.maxRetries`, `retry.maxDelayMs`, and
	 * `retry.waitForUsageReset` are the authority — typed, validated, layered, and
	 * visible to a mid-session change — instead of raw fields on the settings tree.
	 * Fields with no descriptor (`enabled`, `baseDelayMs`, `maxAgentDelayMs`) keep
	 * reading the legacy tree.
	 */
	getRetryPolicy(): RetryPolicyResolution {
		return resolveRetryPolicy({
			registered: (key) => this.getSetting(key),
			legacy: this.settings.retry,
		});
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	/**
	 * Failover policy, defaulting to the safe `free-only`.
	 *
	 * The default matters: recovering a free route must never silently start spending
	 * money, so `compatible` is reachable only by explicit configuration. An
	 * unrecognized value also degrades to `free-only` rather than to a paid-capable one.
	 */
	/**
	 * Resolves the compaction trigger from the two configured limits.
	 *
	 * Both are exposed by the reference: a percentage and an absolute token count.
	 * They answer different questions — the percentage adapts to a small window,
	 * the absolute count stops a large one from waiting until compaction no longer
	 * fits — so neither is derived from the other here.
	 *
	 * Read through the registry rather than a field so a mid-session change takes
	 * effect on the next turn.
	 */
	getCompactionLimits(contextWindow: number): ResolvedCompactionLimits {
		return resolveCompactionLimits({
			contextWindow,
			thresholds: {
				thresholdPercent: this.getSetting("compaction.thresholdPercent")?.value as number | undefined,
				thresholdTokens: this.getSetting("compaction.thresholdTokens")?.value as number | undefined,
			},
		});
	}

	getFailoverPolicy(): FailoverPolicy {
		const configured = this.settings.failover;
		return configured === "off" || configured === "same-provider" || configured === "compatible"
			? configured
			: "free-only";
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : "streaming";
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.globalSettings.cacheWarming = mode;
		this.markModified("cacheWarming");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? true;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.globalSettings.fullscreenCopyOnSelect = enabled;
		this.markModified("fullscreenCopyOnSelect");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
