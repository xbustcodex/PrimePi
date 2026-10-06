/**
 * Typed setting descriptors: the single schema every Pi setting is declared in.
 *
 * A setting is declared once, with its type, default, permitted values, and the
 * metadata the UI needs. The registry is the only place that validates a value or
 * decides which layer supplied it, so a setting cannot drift between the schema,
 * the store, and the picker.
 *
 * Phase 1 scope, deliberately narrow:
 *  - registration, validation, layered reads with provenance, and revision-based
 *    memoization;
 *  - `env` is a *default fallback* only, matching the two settings that already
 *    consult the environment. It is not a general environment override layer.
 *
 * Persistence, `migrateSettings`, the trust gate, and the write queue are
 * unchanged and remain in `SettingsManager`.
 */

export type SettingValue =
	| boolean
	| string
	| number
	| Record<string, string>
	| string[]
	| Record<string, string[]>
	| SettingObjectList;

/**
 * A list of structured entries, e.g. bash approval rules.
 *
 * Distinct from `stringList` because the entries are objects, and from
 * `stringListMap` because there is no key: order is the meaning, so a keyed map
 * would lose it. `bash.patterns` is the reason this exists — a `record` cannot
 * hold it, since the registry requires every value in a record to be a string.
 */
export type SettingObjectList = Record<string, unknown>[];

/**
 * A map whose values are lists of strings, e.g. `{ smol: ["@tiny", "xai/grok-4.5"] }`.
 *
 * Kept distinct from `record` and from `stringList` so a descriptor states which
 * shape it means: a flat string map cannot silently widen to hold lists, and a
 * plain list cannot silently become a map.
 */
export type SettingStringListMap = Record<string, string[]>;

export type SettingSource = "default" | "global" | "project" | "override";

export interface ResolvedSetting<T extends SettingValue = SettingValue> {
	value: T;
	/** Which layer supplied the value, so the UI can explain precedence. */
	source: SettingSource;
	/** False only when the value is the descriptor default. */
	isExplicit: boolean;
}

export interface SettingUiSpec {
	/** Display label for the settings row. */
	label: string;
	description?: string;
	/**
	 * How the control is presented. `cycle` inlines the values into the row;
	 * `submenu` opens a custom component. A setting with no `ui` block is
	 * config-file only and never appears in the picker, so no dead controls.
	 */
	control?: "cycle" | "submenu";
	/**
	 * Display order, lower first.
	 *
	 * Advisory only, and deliberately not authoritative: the picker's real order
	 * lives in the UI binding table, because it also encodes capability conditions
	 * (the image rows appear only on terminals that support them) and the
	 * interleaving the picker previously built with positional splices. This field
	 * exists so `uiSettings()` returns a stable, grouped order for diagnostics and
	 * for any future surface that does not need capability conditions.
	 */
	order?: number;
	/**
	 * Which Settings tab the row belongs in, and which section within it.
	 *
	 * These mirror the OMP panel's structure and are read by the tabbed surface
	 * rather than by a second settings store, so the panel is a projection of this
	 * registry rather than a copy of it. A setting with no `tab` is
	 * config-file only and does not appear in the tabbed panel.
	 */
	tab?: string;
	/** Section heading within the tab. Must be one the tab's group list declares. */
	group?: string;
	/**
	 * Why this row cannot currently be used.
	 *
	 * Set for a setting whose subsystem is not migrated. The row renders as a
	 * disabled marker at its OMP location, and a later wave activates it in
	 * place rather than moving it.
	 */
	unavailable?: string;
	/** Marks a setting PrimePi has and the reference does not. */
	piSpecific?: boolean;
}

export interface SettingDescriptor<T extends SettingValue = SettingValue> {
	/** Dotted path into the persisted settings object, e.g. `terminal.showImages`. */
	key: string;
	type: "boolean" | "string" | "number" | "enum" | "record" | "stringList" | "stringListMap" | "objectList";
	/** Value used when no layer supplies one. */
	default: T;
	/** Permitted values for `enum`, and the cycle order for a `cycle` control. */
	values?: readonly string[];
	/**
	 * Optional narrower type check. Return `undefined` to reject, which is how a
	 * persisted value that no longer satisfies the schema is refused rather than
	 * silently accepted.
	 */
	parse?: (raw: unknown) => T | undefined;
	/** Environment variable consulted only when no layer supplies a value. */
	env?: string;
	/** How to read the environment fallback into T. */
	parseEnv?: (raw: string) => T | undefined;
	/**
	 * Read from the global layer only, ignoring project and overrides. Mirrors the
	 * existing behaviour of settings that are global by design.
	 */
	globalOnly?: boolean;
	ui?: SettingUiSpec;
	/**
	 * Marks the value as a credential or other sensitive material.
	 *
	 * A sensitive value is masked wherever a setting would otherwise be shown or
	 * serialized: the settings picker, diagnostic bundles, and any log including
	 * a settings snapshot. The stored value is untouched — only its *display* is
	 * masked, because the runtime still has to read it.
	 *
	 * This is a declaration, not a second store. Marking a value sensitive
	 * changes how it is presented, never where it lives or who owns it.
	 */
	sensitive?: boolean;
	/**
	 * Whether the masked form preserves the real value's length.
	 *
	 * Off by default: length is itself a disclosure, since it narrows a brute
	 * force. Enable only where a caller must show that a value is set without
	 * revealing how long it is.
	 */
	revealLength?: boolean;
}

export class SettingRegistrationError extends Error {}

export class SettingHandle<T extends SettingValue = SettingValue> {
	readonly id: string;
	readonly descriptor: SettingDescriptor<T>;

	constructor(descriptor: SettingDescriptor<T>) {
		this.descriptor = descriptor;
		this.id = descriptor.key;
	}

	/**
	 * Coerces a raw value (from a file, the UI, or the environment) into this
	 * setting's type, throwing `SettingRegistrationError` when it cannot.
	 *
	 * Rejecting here is the point: an out-of-range enum silently persisted is how a
	 * settings file drifts away from the schema that documents it.
	 */
	parse(raw: unknown): T {
		const { descriptor } = this;
		if (descriptor.parse) {
			const parsed = descriptor.parse(raw);
			if (parsed === undefined) {
				throw new SettingRegistrationError(`Invalid value for setting ${this.id}: ${JSON.stringify(raw)}`);
			}
			return parsed;
		}
		switch (descriptor.type) {
			case "boolean":
				if (typeof raw === "boolean") return raw as T;
				break;
			case "number":
				if (typeof raw === "number" && Number.isFinite(raw)) return raw as T;
				break;
			case "string":
				if (typeof raw === "string") return raw as T;
				break;
			case "enum": {
				if (typeof raw === "string" && descriptor.values?.includes(raw)) return raw as T;
				break;
			}
			case "record": {
				// A record setting accepts only a flat string map, so a stray scalar or a
				// nested object cannot be written into the settings file.
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) break;
				const entries = Object.entries(raw as Record<string, unknown>);
				if (entries.some(([, value]) => typeof value !== "string")) break;
				return Object.fromEntries(entries) as T;
			}
			case "stringList": {
				// A string list accepts only arrays of strings, so a scalar or a nested
				// object cannot be persisted under a key that will be iterated.
				if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) break;
				return [...raw] as T;
			}
			case "stringListMap": {
				// Each value must itself be a string list, so a role entry cannot hold a
				// scalar and silently expand to a single unusable pattern.
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) break;
				const entries = Object.entries(raw as Record<string, unknown>);
				if (entries.some(([, entry]) => !Array.isArray(entry) || entry.some((item) => typeof item !== "string"))) {
					break;
				}
				return Object.fromEntries(entries) as T;
			}
			case "objectList": {
				// An object list accepts only arrays of plain objects. Each entry's own
				// fields are validated by that setting's `parse`, which is the only place
				// that knows the entry shape — this branch just refuses a scalar or a
				// nested list, which no entry schema would accept anyway.
				if (!Array.isArray(raw)) break;
				if (raw.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) break;
				return raw.map((entry) => ({ ...entry })) as T;
			}
		}
		throw new SettingRegistrationError(`Invalid value for setting ${this.id}: ${JSON.stringify(raw)}`);
	}
}

const byKey = new Map<string, SettingHandle>();
const ordered: SettingHandle[] = [];

export function registerSetting<T extends SettingValue>(descriptor: SettingDescriptor<T>): SettingHandle<T> {
	if (byKey.has(descriptor.key)) {
		throw new SettingRegistrationError(`Setting "${descriptor.key}" is registered twice`);
	}
	const handle = new SettingHandle(descriptor);
	byKey.set(descriptor.key, handle as SettingHandle);
	ordered.push(handle as SettingHandle);
	return handle;
}

export function lookupSetting(key: string): SettingHandle | undefined {
	return byKey.get(key);
}

/** Every registered setting, in declaration order. */
export function allSettings(): readonly SettingHandle[] {
	return ordered;
}

/**
 * Placeholder shown in place of a sensitive value.
 *
 * A fixed literal, deliberately carrying no length or shape information, so a
 * masked rendering cannot be used to probe the value it hides.
 */
export const MASKED_SETTING_VALUE = "<set>";

/**
 * Renders a setting's value for display or serialization.
 *
 * Returns the value unchanged for a setting that is not marked sensitive, and
 * a fixed placeholder for one that is. The masked form is identical whether the
 * value is a long credential or a single character, so it discloses neither
 * length nor presence.
 *
 * `revealLength` opts into a length-preserving mask for the rare caller that
 * must distinguish "unset" from "set but short"; it still never reveals the
 * characters themselves.
 */
export function maskSensitiveValue(handle: SettingHandle | undefined, value: unknown): unknown {
	if (!handle?.descriptor.sensitive) return value;
	if (value === undefined || value === null) return value;

	if (!handle.descriptor.revealLength) return MASKED_SETTING_VALUE;

	// Preserve shape without revealing content: a string keeps its length, a list
	// keeps its size, a record keeps its keys. None of those disclose the value.
	if (typeof value === "string") return "*".repeat(Math.max(value.length, 1));
	if (Array.isArray(value)) return new Array(value.length).fill(MASKED_SETTING_VALUE);
	if (typeof value === "object") {
		return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((k) => [k, MASKED_SETTING_VALUE]));
	}
	return MASKED_SETTING_VALUE;
}

/** Settings declared sensitive, for diagnostics and tests. */
export function sensitiveSettings(): readonly SettingHandle[] {
	return ordered.filter((handle) => handle.descriptor.sensitive === true);
}
/** A registered setting that declares UI metadata, and so is picker-visible. */
export type UiSettingHandle = SettingHandle & { descriptor: SettingDescriptor & { ui: SettingUiSpec } };

/**
 * Settings that should appear in the picker, in row order.
 *
 * A descriptor without a `ui` block is deliberately excluded, so adding a
 * config-file-only setting can never produce a control with no behaviour behind it.
 */
export function uiSettings(): readonly UiSettingHandle[] {
	return ordered
		.filter((handle): handle is UiSettingHandle => handle.descriptor.ui !== undefined)
		.sort((a, b) => (a.descriptor.ui?.order ?? 0) - (b.descriptor.ui?.order ?? 0));
}

/** Test-only: clears the registry so a suite can declare descriptors in isolation. */
export function resetSettingRegistryForTests(): void {
	byKey.clear();
	ordered.length = 0;
}

/** Reads a dotted path out of a nested settings object. */
export function readPath(root: unknown, key: string): unknown {
	let current: unknown = root;
	for (const segment of key.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** True when the dotted path resolves to a defined value. */
export function hasPath(root: unknown, key: string): boolean {
	return readPath(root, key) !== undefined;
}

/** Writes a dotted path into a nested settings object, creating intermediate objects. */
/**
 * Remove a value at a dotted path, pruning any object it leaves empty.
 *
 * Pruning matters: a reset that left `{ theme: {} }` behind would still shadow nothing, but it
 * would make the stored file claim a theme section the user had removed.
 */
export function deletePath(root: Record<string, unknown>, key: string): boolean {
	const segments = key.split(".");
	let node: Record<string, unknown> = root;
	// Walk to the parent, holding the chain so emptied ancestors can be pruned on the way out.
	const chain: Record<string, unknown>[] = [];
	for (const segment of segments.slice(0, -1)) {
		const next = node[segment];
		if (typeof next !== "object" || next === null || Array.isArray(next)) return false;
		chain.push(node);
		node = next as Record<string, unknown>;
	}
	const leaf = segments[segments.length - 1]!;
	if (!(leaf in node)) return false;
	delete node[leaf];

	// Walk back up, removing any parent left with no keys of its own.
	for (let i = chain.length - 1; i >= 0; i--) {
		const parent = chain[i]!;
		const childKey = segments[i]!;
		const child = parent[childKey] as Record<string, unknown>;
		if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
			delete parent[childKey];
		} else {
			break;
		}
	}
	return true;
}

export function writePath(root: Record<string, unknown>, key: string, value: SettingValue): void {
	const segments = key.split(".");
	let current = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const next = current[segment];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1]] = value;
}
