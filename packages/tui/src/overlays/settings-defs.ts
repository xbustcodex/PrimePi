/**
 * OMP Settings panel structure: tabs, section groups, and row metadata.
 *
 * ## This is a transcription, not a design
 *
 * The tab list, the tab order, the section groups and their order are taken
 * verbatim from the current OMP reference
 * (`oh-my-pi/packages/tui/src/overlays/settings-defs.ts` at `eabd6b99c6`,
 * `SETTING_TABS:20` and `TAB_GROUPS:52`). The product requirement is that a user
 * familiar with OMP's panel finds the same structure here, so anything invented
 * would be a regression against the reference.
 *
 * Ten tabs. The screenshots show eight labelled ones; the remaining two
 * (`tasks`, `providers`) are icon-only at the right. That is determined from the
 * source ordering, not inferred from the images: the eight visible labels
 * correspond to indices 0-7, and indices 8 and 9 carry no label slot.
 *
 * ## Where the data comes from
 *
 * Not from here. This module declares *structure*; the rows themselves come from
 * each setting's own `ui` metadata in the typed registry, which is the same
 * arrangement OMP uses — `ui.tab` and `ui.group` live on the setting, and these
 * tables order them. So there is exactly one declaration of each setting, and
 * adding a setting cannot desynchronise the panel from the registry.
 *
 * ## PrimePi additions
 *
 * A setting whose tab is not in {@link SETTING_TABS} is placed in
 * {@link PRIMEPI_APPENDED_TAB}, which is appended after the OMP tabs and leaves
 * their order and count untouched. That is how a PrimePi-only capability joins
 * the panel without rearranging the reference's design.
 */

/** The tabs, in the order OMP renders them. */
export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

/**
 * Appended after every OMP tab, for capabilities Pi has that OMP does not.
 *
 * Separate from {@link SETTING_TABS} so the reference order is provably intact:
 * a parity test asserts the OMP slice is unchanged.
 */
export const PRIMEPI_APPENDED_TAB = "primepi" as const;
export type PrimePiTab = typeof PRIMEPI_APPENDED_TAB;
export type AnySettingTab = SettingTab | PrimePiTab;

export interface TabMetadata {
	readonly label: string;
	/** Theme symbol key, resolved through Pi's theme when one exists for it. */
	readonly icon: string;
}

/** Ordered tab list. The first eight are the labelled ones; the last two are icon-only. */
export const SETTING_TABS: readonly SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
];

/** Tab display metadata. */
/**
 * One line of context shown under each tab's title in the selector.
 *
 * Lost in a stash-conflict resolution during the port; the selector reads it for every tab it
 * renders, so it has to exist. `primepi` is absent - it is the appended tab for capabilities
 * OMP does not have, and carries no reference wording.
 */
export const TAB_LEADS: Record<AnySettingTab, string> = {
	appearance: "Theme, composer, status line and how the transcript renders.",
	model: "Thinking, sampling, the system prompt, retries and the helper models.",
	interaction: "Input, approvals, notifications, speech and what happens at startup.",
	context: "What the model sees, and when and how the conversation compacts.",
	memory: "What Prime Pi remembers across sessions and where it keeps it.",
	files: "How files are read, summarized and edited, and the language servers.",
	shell: "The bash tool and the eval runtimes.",
	tools: "Which tools the model has, their limits and the external integrations.",
	tasks: "Modes, subagents, isolation and custom commands.",
	providers: "Services, provider protocols, timeouts and privacy.",
	primepi: "Prime Pi additions.",
};

export type MetadataTab = AnySettingTab | "plugins";
export const TAB_METADATA: Record<MetadataTab, TabMetadata> = {
	// OMP's first tab is `appearance`; the panel shows it as "General".
	appearance: { label: "General", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	memory: { label: "Memory", icon: "tab.memory" },
	files: { label: "Files", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "Tools", icon: "tab.tools" },
	// The last two render icon-only, which is why the reference keeps their
	// labels for accessibility but does not draw them.
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
	// The plugins tab is not one of the registry tabs - it lists extensions - so it is declared
	// here alongside them for the tab bar rather than as a setting path.
	plugins: { label: "Plugins", icon: "tab.plugins" },
	primepi: { label: "PrimePi", icon: "tab.primepi" },
};

/** Tabs drawn with a label. The remainder are icon-only. */
export const LABELLED_TAB_COUNT = 8;

/** True when a tab renders its label, per the reference's layout. */
export function tabIsLabelled(tab: AnySettingTab): boolean {
	const index = ALL_TABS.indexOf(tab);
	return index >= 0 && index < LABELLED_TAB_COUNT;
}

/** Every tab in render order: OMP's, then anything Pi appended. */
export const ALL_TABS: readonly AnySettingTab[] = [...SETTING_TABS, PRIMEPI_APPENDED_TAB];

/**
 * Ordered section headings per tab.
 *
 * A setting with no group renders before the first heading. Transcribed from
 * `TAB_GROUPS` in the reference.
 */
export const TAB_GROUPS: Record<AnySettingTab, readonly string[]> = {
	appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Stream",
		"Magic Keywords",
		"Startup & Updates",
		"Power",
		"Agent",
		"Git",
		"Skills",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"IDA Pro",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Extensions",
		"Developer",
	],
	tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
	providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
	primepi: [],
};

/** A choice inside a submenu, with the description OMP shows beside it. */
export interface SubmenuOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/**
 * The Memory backend selector.
 *
 * Transcribed from the current reference
 * (`memory-backend/settings.ts` plus the option metadata the reference's
 * settings screen renders). The order is the render order and must not be
 * re-sorted: a user who has learned the list selects by position.
 */
export const MEMORY_BACKEND_OPTIONS: readonly SubmenuOption[] = [
	{ value: "off", label: "Off", description: "No persistent memory." },
	{ value: "local", label: "Local", description: "Session-scoped memory held in this process only." },
	{
		value: "hindsight",
		label: "Hindsight",
		description: "Memory maintained by the Hindsight service.",
	},
	{ value: "mnemopi", label: "Mnemopi", description: "Memory maintained by Mnemopi." },
	{
		value: "sharpshooter",
		label: "Sharpshooter",
		description: "Extraction and consolidation by the Sharpshooter model.",
	},
];

/**
 * Section order index for a setting.
 *
 * A group absent from the table sorts after every known group rather than
 * before, so a newly added heading appears at the end of its tab instead of
 * displacing the reference's order.
 */
export function groupIndex(tab: AnySettingTab, group: string | undefined): number {
	if (!group) return -1;
	const groups = TAB_GROUPS[tab];
	const index = groups.indexOf(group);
	return index === -1 ? groups.length : index;
}

/**
 * A numeric setting's value, with the `default` sentinel as `-1`.
 *
 * `undefined` means the stored string was not a number, which the caller surfaces as a reset to
 * the descriptor default rather than silently substituting zero.
 */
export function numericOption(value: string): number | undefined {
	if (value === "default") return -1;
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/**
 * Stepper steps for a setting whose choices are all numbers, or `undefined`.
 *
 * A numeric setting edited as a stepper rather than a text field, because typing a number into a
 * terminal text field is how a timeout becomes `3_600` or an empty string.
 */
export function numberSteps(def: { values?: readonly string[] }): Record<string, string> | undefined {
	const values = def.values;
	if (!values || values.length === 0) return undefined;
	const steps: Record<string, string> = {};
	let allNumeric = true;
	for (const value of values) {
		const n = numericOption(value);
		if (n === undefined) {
			allNumeric = false;
			break;
		}
		steps[String(n)] = value;
	}
	return allNumeric && Object.keys(steps).length > 1 ? steps : undefined;
}

/**
 * One setting as the selector sees it, and the source of its current value.
 *
 * Ported from the reference's `SettingsDisplayEntry`. Prime Pi's parity rows carry the same
 * fields under a different name (`currentValue` for `value`), so the entry is derived from a row
 * rather than being a second description of a setting.
 */
export interface SettingsDisplayEntry {
	/** The registry path, e.g. `theme.dark`. */
	readonly path: string;
	readonly label: string;
	readonly description: string | undefined;
	readonly value: string;
	readonly values: readonly string[] | undefined;
	readonly warning: string | undefined;
	readonly source: string;
	/**
	 * The registry path this setting came from, when it is not its own id.
	 *
	 * Prime Pi's parity rows carry a transcribed reference id *and* the Prime Pi registry key it
	 * maps to. The selector must write through the Prime Pi key, because that is what the runtime
	 * reads; the reference id is only for labelling and for finding the display definition.
	 */
	readonly piKey?: string;
	/** Display metadata needed to pick a control, carried from the parity row. */
	readonly ui: DisplayUiMetadata;
}

/** The display metadata a control is derived from. */
export interface DisplayUiMetadata {
	readonly tab: string;
	readonly group: string | undefined;
	readonly schemaType: string;
	readonly defaultValue: unknown;
	/** `runtime` means the options are only knowable from live state, not from the descriptor. */
	readonly options: ReadonlyArray<SubmenuOption> | "runtime" | undefined;
	readonly condition: (() => boolean) | undefined;
	/** Rendered as a toggle list rather than a single choice. */
	readonly multiSelect: boolean;
	/** The list's order is meaningful and the user may reorder it. */
	readonly ordered: boolean;
	readonly secret: boolean;
}

/**
 * The settings authority the selector reads and writes through.
 *
 * Path-keyed, as in the reference: a selector row knows its registry path and nothing else
 * about where the value lives. That is the property the typed settings registry established, and
 * keying by row instead would tie presentation to the row table.
 *
 * `normalizeProviderLimits` / `validateProviderLimits` are absent: they exist in the reference to
 * coerce a provider's rate-limit object between shapes, and Prime Pi's provider limits are read
 * from the model runtime rather than configured as a raw object.
 */
export interface SettingsHost {
	entries: readonly SettingsDisplayEntry[];
	get(path: string): unknown;
	set(path: string, value: unknown): void;
	/**
	 * Removes the value from the global config, so a project layer, an environment variable, or
	 * the descriptor default still applies.
	 */
	unset(path: string): void;
	/**
	 * Coerce a per-provider rate-limit record into `{ provider: number }`, dropping entries
	 * that are not a positive finite number.
	 *
	 * The stored value is user-editable JSON, so anything can arrive. Normalising here means the
	 * request path receives numbers rather than whatever was typed.
	 */
	normalizeProviderLimits(value: unknown): Record<string, number>;
	/**
	 * The same coercion, applied before a write.
	 *
	 * Separate from normalize so a write can be refused rather than silently changed: a value
	 * that does not validate is reported, not rewritten behind the user's back.
	 */
	validateProviderLimits(value: unknown): Record<string, number>;
}

// SubmenuOption is already declared above as an interface with the same shape; this file grew
// the type alias during the port and the two are interchangeable.

interface BaseSettingDef {
	path: string;
	defaultValue: unknown;
	schemaType: string;
	label: string;
	description: string;
	/** Risk note shown in warning styling; set for settings that can get the user flagged or banned. */
	warning?: string;
	tab: string;
	/** Section within the tab; ordered by TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the setting is hidden.
	 * Applies to every variant.
	 */
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: readonly SubmenuOption[];
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

/** Array-of-enum setting edited as a toggle list; `ordered` renders positions and allows reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: readonly SubmenuOption[];
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| MultiSelectSettingDef;

function resolveOptions(ui: DisplayUiMetadata): readonly SubmenuOption[] | "runtime" | undefined {
	if (!ui.options) return undefined;
	return ui.options;
}

/**
 * The control a setting is edited with.
 *
 * Derived from its declared type, the same way the reference derives it: a boolean is a
 * toggle, an enum with known values cycles, an enum whose values are only knowable at runtime
 * opens a submenu, a number with numeric options steps, anything else is text.
 *
 * Returns `null` for a setting with no `ui` block. Those are config-file only by construction -
 * they never appear in a picker - and inventing a control for them here would surface settings
 * the product deliberately hides.
 */
function entryToSettingDef(entry: SettingsDisplayEntry): SettingDef | null {
	const { path, ui } = entry;
	if (!ui) return null;
	const schemaType = ui.schemaType;
	const base = {
		path,
		defaultValue: ui.defaultValue,
		schemaType,
		label: entry.label,
		description: entry.description ?? "",
		warning: entry.warning,
		tab: ui.tab,
		group: ui.group,
		condition: ui.condition,
	};

	if (schemaType === "boolean") return { ...base, type: "boolean" };

	const options = resolveOptions(ui);
	if (ui.multiSelect && options && options !== "runtime") {
		return { ...base, type: "multiselect", options, ordered: ui.ordered };
	}

	if (schemaType === "enum") {
		if (options === undefined) return { ...base, type: "enum", values: entry.values ?? [] };
		// "runtime" is not a valid sentinel for an enum: the schema type prevents it, but treat
		// it defensively as an empty submenu rather than rendering `runtime` as an option.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	// A number without numeric options is intentionally hidden: there is nothing to step
	// through and a bare numeric field is how a timeout becomes an empty string.
	if (schemaType === "number") {
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	return { ...base, type: "text", secret: ui.secret };
}

/** Every setting that has a control, in display-entry order. */
export function getAllSettingDefs(entries: readonly SettingsDisplayEntry[]): SettingDef[] {
	const defs: SettingDef[] = [];
	for (const entry of entries) {
		const def = entryToSettingDef(entry);
		if (def) defs.push(def);
	}
	return defs;
}

/** The settings for one tab, grouped by TAB_GROUPS order. */
export function getSettingsForTab(entries: readonly SettingsDisplayEntry[], tab: string): SettingDef[] {
	const defs = getAllSettingDefs(entries).filter((def) => def.tab === tab);
	const order = TAB_GROUPS[tab as AnySettingTab] ?? [];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		// An unlisted group sorts after every listed one, so it is visible rather than dropped.
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** The display definition for one settings path. */
export function getSettingDef(entries: readonly SettingsDisplayEntry[], path: string): SettingDef | undefined {
	return getAllSettingDefs(entries).find((def) => def.path === path);
}
