/**
 * Code mode: collapse the direct tool surface for models that reason in cells.
 *
 * ## What it does
 *
 * A `code_mode_only` model is given a small keep-set of tools it may call
 * directly, and reaches everything else through the eval bridge. This mirrors
 * codex-rs `ToolMode::CodeModeOnly`.
 *
 * ## The keep-set is not a preference, it is a correctness constraint
 *
 * Several tools are in it because machinery keys on the `toolResult`'s
 * `toolName`:
 *
 * - `checkpoint` and `rewind` drive session state tracked by name. Wrapped
 *   inside an eval result they become invisible to that machinery, so the
 *   checkpoint appears to succeed and the rewind appears to do nothing.
 * - `new_context` rollover requests have the same dependency.
 *
 * So these stay direct not because the model needs them most, but because
 * *nothing else can see them work*.
 *
 * The `__*__` entries are the eval bridge's own internal operations, listed
 * literally so this module stays free of eval imports. `callSessionTool`
 * consumes them before the registry, so a registered tool sharing one of those
 * names is only reachable while it stays on the direct surface.
 *
 * ## `auto` follows the catalog, and never overrides an explicit choice
 *
 * `auto` activates only when the model catalog says the model is
 * `code_mode_only`. An explicit `on` activates regardless. Inactive returns
 * *every* enabled name, not the keep-set — a partially-collapsed surface that is
 * not code mode would silently remove tools.
 *
 * ## Wire-name collisions have a defined winner
 *
 * Two tools can resolve to the same wire name. Direct exposure beats a bridged
 * entry, because a bridged tool is only reachable by a name the model has to
 * know to type. Between two direct entries the exact tool name beats an alias,
 * matching the dispatcher's exact-name-first lookup — so the entry the
 * dispatcher would route to is the one the model is shown.
 */

/** Tools that always stay directly model-visible under code mode. */
export const CODE_MODE_KEEP_TOOLS: ReadonlySet<string> = new Set([
	"eval",
	"ask",
	"todo",
	"yield",
	"think",
	// checkpoint/rewind results drive session state machinery keyed on the
	// toolResult's toolName; wrapped inside an eval result they are invisible to
	// it, so they must stay direct.
	"checkpoint",
	"rewind",
	// Rollover requests likewise depend on the direct toolResult's toolName.
	"new_context",
	// The eval bridge's own internal operations.
	"__agent__",
	"__budget__",
	"__completion__",
	"__wait__",
	"__status__",
	"__cancel__",
	"__workpool__",
]);

export interface CodeModeResolution {
	readonly active: boolean;
	/** Names that remain directly model-visible. All enabled names when inactive. */
	readonly directToolNames: ReadonlySet<string>;
}

export interface CodeModeInput {
	readonly provider: string;
	/** The catalog's `toolMode` for this model, consulted only in `auto`. */
	readonly toolMode?: string;
	readonly setting: "off" | "on" | "auto";
	readonly extraDirectTools?: readonly string[];
	readonly enabledToolNames: readonly string[];
	/** False when no eval transport is wired, which makes code mode impossible. */
	readonly evalTransportAvailable: boolean;
}

/**
 * Decides which tools stay directly visible.
 *
 * All four activation conditions are required, not just the setting: the bridge
 * is the whole point, so a model with no eval transport gets the full surface
 * rather than a keep-set it cannot escape.
 */
export function resolveCodeMode(input: CodeModeInput): CodeModeResolution {
	const active =
		input.provider === "openai-codex" &&
		input.enabledToolNames.includes("eval") &&
		input.evalTransportAvailable &&
		(input.setting === "on" || (input.setting === "auto" && input.toolMode === "code_mode_only"));

	// Inactive returns everything. Returning the keep-set instead would silently
	// remove tools from a session that never opted into code mode.
	if (!active) return { active: false, directToolNames: new Set(input.enabledToolNames) };

	const direct = new Set<string>();
	for (const name of input.enabledToolNames) {
		if (CODE_MODE_KEEP_TOOLS.has(name)) direct.add(name);
	}
	for (const name of input.extraDirectTools ?? []) {
		// An extra name that is not enabled cannot be exposed; the caller asked for
		// a tool this session does not have.
		if (input.enabledToolNames.includes(name)) direct.add(name);
	}
	return { active: true, directToolNames: direct };
}

/** One tool as advertised to the model. */
export interface NamespaceTool {
	readonly name: string;
	readonly customWireName?: string;
	readonly loadMode?: string;
	readonly mcpServerName?: string;
}

/** One callable, in the shape codex-rs puts on the wire. */
export interface NamespaceFunction {
	name: string;
	direct: boolean;
	code_mode_name: string | null;
	deferred: boolean;
	source: { kind: "harness" } | { kind: "mcp"; server_name: string };
}

export type ToolNamespacesInfo = {
	[namespace: string]: {
		name: string;
		functions: Record<string, NamespaceFunction>;
	};
};

/** Reported when two tools resolve to the same wire name. */
export interface WireCollision {
	readonly wireName: string;
	readonly kept: string;
	readonly dropped: string;
}

/**
 * Builds the namespace table.
 *
 * The map has a **null prototype** on purpose: a tool named `toString` or
 * `__proto__` must land as an own entry rather than reading or replacing an
 * inherited member, which would silently drop the tool.
 */
export function buildToolNamespacesInfo(input: {
	readonly tools: readonly NamespaceTool[];
	readonly directToolNames: ReadonlySet<string>;
}): { info: ToolNamespacesInfo; collisions: WireCollision[] } {
	const functions: Record<string, NamespaceFunction> = Object.create(null);
	const collisions: WireCollision[] = [];
	for (const tool of input.tools) {
		const direct = input.directToolNames.has(tool.name);
		// A direct tool may be published under a shorter alias; a bridged one keeps
		// its own name, because reaching it requires typing that name.
		const wireName = direct ? (tool.customWireName ?? tool.name) : tool.name;
		const existing = functions[wireName];
		if (existing !== undefined) {
			const existingExact = existing.code_mode_name === wireName;
			const candidateExact = tool.name === wireName;
			// One wire name can only denote one callable. Direct beats bridged,
			// because a bridged tool is only reachable by a name the model must know
			// to type. Between two direct entries, the exact name beats an alias,
			// matching the dispatcher's exact-name-first lookup.
			const replace = direct && (!existing.direct || (candidateExact && !existingExact));
			collisions.push({
				wireName,
				kept: replace ? tool.name : (existing.code_mode_name ?? wireName),
				dropped: replace ? (existing.code_mode_name ?? wireName) : tool.name,
			});
			if (!replace) continue;
		}
		functions[wireName] = {
			name: wireName,
			direct,
			code_mode_name: tool.name,
			deferred: tool.loadMode === "discoverable",
			source: tool.mcpServerName ? { kind: "mcp", server_name: tool.mcpServerName } : { kind: "harness" },
		};
	}
	return { info: { functions: { name: "functions", functions } }, collisions };
}
