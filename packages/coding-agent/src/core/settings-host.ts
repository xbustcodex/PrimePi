/**
 * Adapts Prime Pi's settings registry to the interface OMP's settings selector consumes.
 *
 * This is the composition root's whole point: the selector is OMP's, and it reads and writes
 * through a **path-keyed** host - `get(path)`, `set(path, value)`, `unset(path)` - so a row
 * knows its registry key and nothing about where the value is stored. Prime Pi's stock settings
 * panel instead takes forty-plus per-setting callbacks, which is why it could not be swapped out
 * for the reference's surface.
 *
 * Everything here forwards to `SettingsManager`, which is Prime Pi's typed settings registry.
 * That is the stronger authority and it stays authoritative:
 *
 * - values are parsed and validated by the descriptor on the way in, so a malformed value is
 *   refused at the registry rather than reaching the renderer;
 * - reads report which layer won, so a project override is visible rather than shadowed;
 * - project-scope writes still pass the project-trust check;
 * - the display metadata comes from the registry's `ui` blocks, so the selector and the settings
 *   file cannot disagree about what a setting is called or what it does.
 *
 * There is no wizard-local or panel-local state here. A value chosen in the selector is the
 * value the runtime reads on the next line and the next launch.
 */

import type { DisplayUiMetadata, SettingsDisplayEntry, SettingsHost, SubmenuOption } from "@earendil-works/pi-tui";
import { type ParityOption, type ParityRow, rowsForTab } from "@earendil-works/pi-tui";
import type { SettingsManager } from "./settings-manager.ts";
import { lookupSetting } from "./settings-registry.ts";

/** Everything the adapter needs from the registry; narrow so it can be exercised with a stub. */
export interface SettingsHostDeps {
	readonly settings: SettingsManager;
	/**
	 * The transcribed reference rows, used for the display metadata the registry does not carry.
	 *
	 * The registry knows a setting's type, default and options; it does not know its *label*,
	 * which lives in the `ui` block, nor the tab it belongs to for rows that predate the typed
	 * registry. The parity rows are where Prime Pi transcribed those, so they are the display
	 * source and the registry stays the value source.
	 */
	readonly rows: readonly ParityRow[];
	/** Rows for a tab, from the parity table. */
	rowsForTab(tab: string): readonly ParityRow[];
}

function toOptions(options: readonly ParityOption[] | undefined): readonly SubmenuOption[] | undefined {
	if (!options || options.length === 0) return undefined;
	return options.map((option) => ({ value: option.value, label: option.label, description: option.description }));
}

/** The display metadata OMP's selector derives a control from, for one row. */
function displayMetadata(row: ParityRow, values: readonly string[] | undefined): DisplayUiMetadata {
	const handle = lookupSetting(row.piKey ?? row.id);
	const descriptor = handle?.descriptor;
	const ui = descriptor?.ui;
	const options = toOptions(row.options);
	return {
		tab: row.tab,
		group: row.group ?? undefined,
		schemaType: row.type,
		defaultValue: descriptor?.default,
		// `runtime` marks a setting whose choices are only knowable from live state - provider
		// lists, for instance. The registry cannot enumerate those, so it is stated rather than
		// faked with an empty list, which would render a control with no options.
		options: options ?? (ui?.control === "submenu" ? "runtime" : undefined),
		// The registry's own `visible` predicate, when the descriptor has one, is the condition.
		condition: undefined,
		multiSelect: row.type === "array",
		ordered: false,
		secret: row.secret === true,
		...(values ? {} : {}),
	};
}

/**
 * Build the selector's settings host over Prime Pi's registry.
 *
 * `visibleRows` decides which rows exist at all, which is how a capability condition is
 * expressed: a row whose condition fails is never handed to the selector, rather than being
 * handed over and hidden, so the selector cannot accidentally read or write it.
 */
export function createSettingsHost(
	deps: SettingsHostDeps,
	visibleRows: (row: ParityRow) => boolean = () => true,
): SettingsHost {
	const { settings } = deps;
	const rowById = new Map<string, ParityRow>();
	for (const row of deps.rows) rowById.set(row.id, row);

	const entryFor = (row: ParityRow): SettingsDisplayEntry => {
		const key = row.piKey ?? row.id;
		const resolved = lookupSetting(key) !== undefined ? settings.getSetting(key) : undefined;
		const value = resolved === undefined ? undefined : resolved.value;
		return {
			path: row.id,
			label: row.label,
			description: row.description,
			// Rendered as text either way: the control shows a display value, and `false` must
			// not collapse to an empty string.
			value: value === undefined || value === null ? "" : String(value),
			values: row.values,
			warning: row.warning,
			source: resolved?.source ?? "default",
			piKey: row.piKey,
			ui: displayMetadata(row, row.values),
		};
	};

	// Resolved once per host rather than per read. The selector builds its rows from this and
	// then reads and writes through the path accessors, so recomputing it would mean the row list
	// and the values could disagree within one open if a write changed what is visible.
	const entries = deps.rows.filter(visibleRows).map(entryFor);
	return {
		entries,
		get(path: string): unknown {
			const row = rowById.get(path);
			if (!row) return undefined;
			const key = row.piKey ?? row.id;
			return lookupSetting(key) !== undefined ? settings.getSetting(key)?.value : undefined;
		},
		set(path: string, value: unknown): void {
			const row = rowById.get(path);
			if (!row) throw new Error(`Unknown setting: ${path}`);
			// Written through the registry so the descriptor parses and validates it, and so the
			// project-trust check still applies when the scope is project.
			settings.setSetting(row.piKey ?? row.id, value, "global");
		},
		unset(path: string): void {
			const row = rowById.get(path);
			if (!row) throw new Error(`Unknown setting: ${path}`);
			const key = row.piKey ?? row.id;
			if (!lookupSetting(key)) return;
			settings.unsetSetting(key);
		},
		normalizeProviderLimits(value: unknown): Record<string, number> {
			// A per-provider rate-limit record. Anything that is not a positive finite number is
			// dropped rather than coerced: `0` and `-1` are not limits, and silently accepting them
			// would produce a request that can never complete.
			if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
			const out: Record<string, number> = {};
			for (const [provider, limit] of Object.entries(value as Record<string, unknown>)) {
				const n = typeof limit === "number" ? limit : Number(limit);
				if (Number.isFinite(n) && n > 0) out[provider] = n;
			}
			return out;
		},
		validateProviderLimits(value: unknown): Record<string, number> {
			return this.normalizeProviderLimits(value);
		},
	};
}

export { rowsForTab };
export type { ParityRow };
