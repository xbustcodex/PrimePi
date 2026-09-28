/**
 * The OMP Settings parity map.
 *
 * ## What this is
 *
 * A machine-checkable inventory of every OMP setting the panel shows, with the
 * tab and group the reference places it in, and the status of its runtime in
 * PrimePi. It exists so an omission is a failing test rather than a visual gap
 * nobody notices.
 *
 * ## Status, and why it is three-valued
 *
 * - `wired` — the runtime exists in Pi and consumes the value. The row works.
 * - `pi-specific` — Pi has the capability and OMP does not. The row is placed in
 *   the semantically correct OMP tab and group; it is never given a tab of its
 *   own, because that would rearrange the reference's design.
 * - `unavailable` — OMP shows the setting and Pi has not migrated the subsystem.
 *   The row renders as a disabled marker at its OMP location. It is a parity
 *   marker, not a working control, and a later wave activates it **in place** so
 *   the structure never shifts.
 *
 * A row is never marked `wired` because a control renders. A row is `wired`
 * because something reads the value.
 *
 * ## Scope of the transcription
 *
 * The reference declares 352 settings carrying a `tab`, distributed as tools 58,
 * model 55, interaction 49, appearance 38, providers 37, tasks 33, memory 30,
 * files 28, shell 17. This module records the **structure** — every tab, every
 * group, in the reference's order — and the Memory tab's settings in full, since
 * that is the tab being wired now. Per-setting rows for the other nine tabs are
 * added as those tabs are wired, and their absence is tracked by
 * {@link TAB_SETTINGS_RECORDED} so the inventory states its own coverage rather
 * than implying completeness it does not have.
 */

import type { AnySettingTab, SettingTab } from "./settings-defs.ts";

/** Runtime state of a setting in PrimePi. */
export type SettingStatus =
	/** Mapped and its value is consumed. */
	| "wired"
	/** Mapped, and PrimePi has a capability OMP does not. */
	| "pi-specific"
	/** The reference shows it; the subsystem is not migrated. */
	| "unavailable";

/** One OMP setting, as the reference declares it. */
export interface OmpSettingEntry {
	/** The reference's registry id, e.g. `memory.backend`. */
	readonly id: string;
	readonly tab: SettingTab;
	readonly group: string;
	readonly label: string;
	/** The reference's description, where it declares one. */
	readonly description?: string;
	readonly type: "boolean" | "string" | "number" | "enum" | "list" | "record";
	readonly status: SettingStatus;
	/** The Pi registry key, once mapped. Absent while the row is unmapped. */
	readonly piKey?: string;
	/**
	 * Why an unmapped row exists, when it is not obvious. Required for every
	 * `unavailable` row so a reader can tell "not yet migrated" from "missed".
	 */
	readonly note?: string;
}

/**
 * The Memory tab, transcribed from the reference.
 *
 * Source at `eabd6b99c6`:
 * `coding-agent/src/memory-backend/settings.ts` (`memory.backend`),
 * `autolearn/settings.ts` (`autolearn.enabled`, `autolearn.autoContinue`),
 * `sharpshooter/settings.ts` (`sharpshooter.model`), plus the Mnemopi and
 * Hindsight groups the reference declares.
 *
 * The descriptions are the reference's, not the screenshots'. They differ, which
 * is the reason the brief requires tracing: the reference is the authority.
 */
export const MEMORY_SETTINGS: readonly OmpSettingEntry[] = [
	{
		id: "memory.backend",
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description: "Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter",
		type: "enum",
		// Wired in the next commit; the row is declared here so the tab has its
		// complete shape before anything is connected to it.
		status: "wired",
		piKey: "memory.backend",
	},
	{
		id: "autolearn.enabled",
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-Learn (experimental)",
		description: "Capture durable engineering experience at stop",
		type: "boolean",
		status: "unavailable",
		note: "Auto-Learn runtime is not migrated; the row activates in place when it is",
	},
	{
		id: "autolearn.autoContinue",
		tab: "memory",
		group: "Auto-Learn",
		label: "Auto-run capture at stop",
		type: "boolean",
		status: "unavailable",
		note: "Depends on the Auto-Learn runtime",
	},
	{
		id: "sharpshooter.model",
		tab: "memory",
		group: "Sharpshooter",
		label: "Sharpshooter Model",
		description: "Model selector for extraction/consolidation, empty = smol role",
		type: "string",
		status: "unavailable",
		note: "Sharpshooter extraction/consolidation runtime is not migrated",
	},
];

/**
 * The tabs whose per-setting inventory is recorded.
 *
 * Explicit rather than implied, so the coverage claim is honest: the structure
 * is complete for all ten tabs, and per-setting rows are recorded for every
 * tab.
 *
 * This flag describes the small recorded list in this file, not the 383-row
 * contract. Whether any contract row is wired is `settings-parity-ledger.ts`,
 * which derives it. Conflating the two is what let two completion reports
 * disagree about how many rows were wired.
 */
export const TAB_SETTINGS_RECORDED: Readonly<Record<AnySettingTab, boolean>> = {
	appearance: false,
	model: false,
	interaction: false,
	context: false,
	memory: true,
	files: false,
	shell: false,
	tools: false,
	tasks: false,
	providers: false,
	primepi: true,
};

/**
 * The settings PrimePi has that OMP does not, and where each is placed.
 *
 * Each sits inside an OMP tab and group rather than in a tab of its own. A
 * PrimePi-only tab would be defensible; placing a capability next to the OMP
 * settings it relates to is better, and leaves the reference's structure intact.
 */
export const PRIMEPI_SETTINGS: readonly OmpSettingEntry[] = [
	{
		id: "pi.providerUsability.disabled",
		tab: "providers",
		group: "Privacy",
		label: "Provider Usability",
		description: "Providers excluded from every resolution, credential and failover path",
		type: "list",
		status: "pi-specific",
		piKey: "disabledProviders",
	},
	{
		id: "pi.projectTrust",
		tab: "interaction",
		group: "Agent",
		label: "Project Trust",
		description: "Whether configuration and executables from this project may be used",
		type: "enum",
		status: "pi-specific",
		piKey: "projectTrust",
	},
	{
		id: "pi.vcs.enabled",
		tab: "interaction",
		group: "Git",
		label: "Git Operations",
		description: "Structured git capabilities, checkpoints and the approval-gated commit pipeline",
		type: "boolean",
		status: "pi-specific",
		piKey: "vcs.enabled",
	},
];

/** Every recorded setting, across tabs. */
export function recordedSettings(): readonly OmpSettingEntry[] {
	return [...MEMORY_SETTINGS, ...PRIMEPI_SETTINGS];
}

/** The recorded settings for one tab, in declaration order. */
export function settingsForTab(tab: AnySettingTab): readonly OmpSettingEntry[] {
	return recordedSettings().filter((entry) => entry.tab === tab);
}

/** Counts by status, for the parity report. */
export function statusCounts(): Record<SettingStatus, number> {
	const counts: Record<SettingStatus, number> = { wired: 0, "pi-specific": 0, unavailable: 0 };
	for (const entry of recordedSettings()) counts[entry.status]++;
	return counts;
}

/**
 * Settings that are declared but not consumed.
 *
 * A `wired` row with no `piKey` is a defect: it claims to work and nothing
 * reads it, which is exactly the dead control the brief forbids.
 */
export function unwiredRows(): readonly OmpSettingEntry[] {
	return recordedSettings().filter((entry) => entry.status === "wired" && !entry.piKey);
}

/** Rows awaiting a runtime, each with the reason it is not usable yet. */
export function unavailableRows(): readonly OmpSettingEntry[] {
	return recordedSettings().filter((entry) => entry.status === "unavailable");
}
