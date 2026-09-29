/**
 * Eval-defined tools: letting a running kernel hand new tools to a subagent.
 *
 * ## This is a trust boundary, and it is deliberately narrow
 *
 * A tool defined inside an eval cell runs with the cell's privileges. Exposing
 * one to a subagent means handing that privilege to code the subagent will
 * choose to call — so the whole surface is behind a single switch, and the
 * switch defaults to on only because defining a tool is itself an explicit act by
 * the operator. A session that did not ask for eval tools gets an error naming
 * the setting rather than an empty list, because "your tool is missing" and
 * "the feature is off" are different problems with different fixes.
 *
 * ## A name may come from one kernel only
 *
 * Python and JS kernels are queried in parallel and their results merged. A name
 * defined in both is a hard error rather than a last-writer-wins merge: the two
 * implementations can differ in arity, in side effects, and in what they
 * return, and a subagent that calls the name has no way to tell which one it
 * got. Failing at definition time is the only point where the operator can
 * still fix it.
 *
 * ## Order is the caller's, not the registry's
 *
 * A request for `["b", "a"]` is answered in that order, because the caller may
 * be building a prompt or a display list where position matters. Deduplicating
 * preserves first occurrence for the same reason.
 *
 * ## An intent field the schema does not declare is stripped
 *
 * The harness annotates tool calls with an intent. If a kernel-defined schema
 * does not declare that field, passing it through would send an argument the
 * implementation never asked for. A schema that *does* declare it keeps it,
 * because there the author meant it.
 */

export type EvalLanguage = "python" | "js";

export interface EvalToolDescriptor {
	readonly name: string;
	readonly language: EvalLanguage;
	/** JSON-Schema for the arguments. */
	readonly parameters?: Readonly<Record<string, unknown>>;
	readonly description?: string;
}

/** Thrown for conditions the operator has to resolve, not retry around. */
export class EvalToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalToolError";
	}
}

/** The field the harness uses to annotate a call's intent. */
export const INTENT_FIELD = "__intent__";

/**
 * Merges per-kernel descriptors, rejecting a name defined in both.
 *
 * The two kernels are queried concurrently, so the merge is where the collision
 * has to be caught. A name defined twice can differ in arity, side effects and
 * return shape, and the subagent calling it cannot tell which one it reached.
 */
export function mergeEvalTools(perKernel: readonly EvalToolDescriptor[][]): EvalToolDescriptor[] {
	const byName = new Map<string, EvalToolDescriptor>();
	for (const descriptors of perKernel) {
		for (const descriptor of descriptors) {
			const existing = byName.get(descriptor.name);
			// A same-language duplicate is the same definition reported twice, which
			// is harmless. A cross-language duplicate is two different functions
			// answering to one name.
			if (existing && existing.language !== descriptor.language) {
				throw new EvalToolError(
					`eval tool "${descriptor.name}" is defined in both the Python and JS kernels; undefine one`,
				);
			}
			byName.set(descriptor.name, descriptor);
		}
	}
	return [...byName.values()];
}

/**
 * Resolves requested names against what the kernels actually defined.
 *
 * Deduplicating preserves first occurrence, because the caller may be building
 * an ordered prompt where position matters.
 */
export function resolveRequestedTools(
	available: readonly EvalToolDescriptor[],
	requested: readonly string[],
	{ enabled = true }: { enabled?: boolean } = {},
): EvalToolDescriptor[] {
	const wanted = [...new Set(requested.filter((name) => name.length > 0))];
	if (wanted.length === 0) return [];
	if (!enabled) {
		// Named explicitly rather than returning empty: "the feature is off" and
		// "your tool is missing" need different fixes.
		throw new EvalToolError(
			"Eval-defined tools are disabled; set eval.tools.enabled=true to expose them to subagents.",
		);
	}
	const byName = new Map(available.map((tool) => [tool.name, tool]));
	const missing = wanted.filter((name) => !byName.has(name));
	if (missing.length > 0) {
		// Sorted so the message is stable between runs, which matters because this
		// text is read by a model choosing what to do next.
		const names = available.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
		throw new EvalToolError(
			`Unknown eval tool(s): ${missing.join(", ")}. Define them with @tool (Python) or tool(fn, {…}) (JS) in an eval cell first. Available: ${names.join(", ") || "none"}`,
		);
	}
	return wanted.flatMap((name) => {
		const descriptor = byName.get(name);
		return descriptor ? [descriptor] : [];
	});
}

/** Whether a schema declares the intent field. */
export function schemaDeclaresIntentField(parameters: Readonly<Record<string, unknown>> | undefined): boolean {
	const properties = parameters?.properties;
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return false;
	return Object.hasOwn(properties, INTENT_FIELD);
}

/**
 * Strips the harness intent annotation when the schema does not declare it.
 *
 * A schema that does declare the field keeps it, because there the author meant
 * a parameter by that name.
 */
export function stripHarnessIntent(
	params: Readonly<Record<string, unknown>>,
	parameters: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	if (!Object.hasOwn(params, INTENT_FIELD)) return { ...params };
	if (schemaDeclaresIntentField(parameters)) return { ...params };
	const { [INTENT_FIELD]: _intent, ...args } = params;
	return args;
}

/** How a kernel tool's return value is rendered. */
export function renderEvalResult(value: unknown): string {
	if (typeof value === "string") return value || "(empty result)";
	if (value === null || value === undefined) return "(no result)";
	// The JSON fallback is for a kernel that returned a non-string; the ?? keeps a
	// value that stringifies to undefined from rendering as blank.
	return JSON.stringify(value, null, 2) ?? String(value);
}
