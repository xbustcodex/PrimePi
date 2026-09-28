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
export const TAB_METADATA: Record<AnySettingTab, TabMetadata> = {
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
