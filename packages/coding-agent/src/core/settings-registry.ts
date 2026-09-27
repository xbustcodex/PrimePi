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

export type SettingValue = boolean | string | number | Record<string, string> | string[] | Record<string, string[]>;

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
}

export interface SettingDescriptor<T extends SettingValue = SettingValue> {
	/** Dotted path into the persisted settings object, e.g. `terminal.showImages`. */
	key: string;
	type: "boolean" | "string" | "number" | "enum" | "record" | "stringList" | "stringListMap";
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
