/**
 * Compaction methods: what to do when the context fills up.
 *
 * ## The order is a preference, not a plan
 *
 * Five methods can each maintain the context, and they differ in cost far more
 * than in quality. The configured order is tried in turn; whatever is
 * unavailable or fails advances to the next. So the order encodes a cost
 * preference — the default puts free, local methods ahead of the ones that make
 * an LLM call, and puts server-native first because when it is available it is
 * both free and lossless.
 *
 * ## Two methods make no LLM call at all
 *
 * `snapcompact` archives history onto dense bitmaps the model reads back;
 * `shake` drops recoverable heavy content in place. Both are effectively
 * instant, which is why they return `undefined` from the speculation query
 * rather than a method name: there is nothing to speculate about. Reporting them
 * would put a marker on the context gauge for an operation that has already
 * happened by the time the user could see it.
 *
 * ## A method can be unavailable for a specific reason
 *
 * `remote` needs either a configured endpoint or a provider-native route.
 * `snapcompact` needs a model that can read images. `handoff` and `soft` are
 * always available. The availability check is per-candidate, so an unavailable
 * first choice silently advances rather than failing the whole pass.
 *
 * ## A configured order is filtered, never trusted
 *
 * Unknown entries are dropped and duplicates collapse to their first
 * occurrence. A hand-edited order containing a typo should degrade to the
 * methods that do exist, not throw — and a duplicated method should not be
 * attempted twice, which would run the same compaction twice if the first
 * attempt failed for a transient reason.
 */

/** The selectable methods, with what each costs. */
export const COMPACTION_METHOD_CHOICES = [
	{
		value: "remote",
		label: "Server compaction",
		requiresLlmCall: false,
		description: "Provider-native server compaction, when the active route supports it",
	},
	{
		value: "snapcompact",
		label: "Snapcompact",
		requiresLlmCall: false,
		description: "Archive history onto dense images the active vision model reads back",
	},
	{
		value: "handoff",
		label: "Handoff",
		requiresLlmCall: true,
		description: "Generate a handoff document and continue from it as the summary",
	},
	{
		value: "shake",
		label: "Shake",
		requiresLlmCall: false,
		description: "Drop recoverable heavy content in place",
	},
	{
		value: "soft",
		label: "Soft compaction",
		requiresLlmCall: true,
		description: "Summarize in place with a compaction model",
	},
] as const;

export type CompactionMethod = (typeof COMPACTION_METHOD_CHOICES)[number]["value"];

const METHODS: ReadonlySet<string> = new Set(COMPACTION_METHOD_CHOICES.map((choice) => choice.value));

/**
 * Default order: server-native first, portable summary last.
 *
 * Server-native is first because when it is available it is both free and
 * lossless. The two local methods follow, then the LLM-calling ones.
 */
export const DEFAULT_COMPACTION_METHOD_ORDER: readonly CompactionMethod[] = [
	"remote",
	"snapcompact",
	"handoff",
	"shake",
	"soft",
];

/** Methods that need no LLM call, and so are effectively instant. */
export const LOCAL_COMPACTION_METHODS: ReadonlySet<CompactionMethod> = new Set<CompactionMethod>([
	"remote",
	"snapcompact",
	"shake",
]);

/** Whether a value names a supported method. */
export function isCompactionMethod(value: unknown): value is CompactionMethod {
	return typeof value === "string" && METHODS.has(value);
}

/**
 * Filters a configured order down to real methods, first occurrence wins.
 *
 * A hand-edited order containing a typo degrades to the methods that do exist
 * rather than throwing. A duplicate collapses to its first occurrence, so a
 * method that failed once is not attempted again in the same pass — which would
 * run the same compaction twice when the first failure was transient.
 */
export function resolveCompactionMethodOrder(value: unknown): CompactionMethod[] {
	if (!Array.isArray(value)) return [];
	const methods: CompactionMethod[] = [];
	for (const method of value) {
		if (isCompactionMethod(method) && !methods.includes(method)) methods.push(method);
	}
	return methods;
}

/** What the engine needs to run one method. */
export interface MethodAvailability {
	/** Server compaction has an endpoint or a provider-native route. */
	readonly remoteAvailable: boolean;
	/** The active model can read images, which snapcompact requires. */
	readonly modelAcceptsImages: boolean;
}

/** Whether one method can run right now, and why not when it cannot. */
export function isMethodAvailable(method: CompactionMethod, availability: MethodAvailability): boolean {
	switch (method) {
		case "remote":
			return availability.remoteAvailable;
		case "snapcompact":
			// Archiving onto bitmaps is useless to a model that cannot read them.
			return availability.modelAcceptsImages;
		// Both LLM-calling methods are always available in principle; if one fails,
		// the loop advances rather than treating it as unavailable up front.
		case "handoff":
		case "soft":
		case "shake":
			return true;
	}
}

export interface MethodAttempt {
	readonly method: CompactionMethod;
	readonly outcome: "succeeded" | "unavailable" | "failed";
	/** Set when the method ran and failed. */
	readonly reason?: string;
}

/** The result of walking the preference order. */
export interface MethodResolution {
	/** The method that ran and succeeded, if any. */
	readonly succeeded?: CompactionMethod;
	/** Every method considered, in the order they were tried. */
	readonly attempts: readonly MethodAttempt[];
	/**
	 * True when every configured method was tried and none succeeded. The caller
	 * must not silently continue: the context is still full.
	 */
	readonly exhausted: boolean;
}

/**
 * Walks the preference order until one method succeeds.
 *
 * Availability is checked before the attempt, so an unavailable method is
 * recorded as `unavailable` rather than `failed` — the distinction is what lets
 * a caller tell "this route cannot do it" from "this route tried and broke",
 * which need different remediation.
 */
export function selectCompactionMethod(input: {
	readonly order: readonly string[];
	readonly availability: MethodAvailability;
	/** Runs the method. Returning a reason means it failed. */
	readonly run: (method: CompactionMethod) => string | undefined;
}): MethodResolution {
	const attempts: MethodAttempt[] = [];
	for (const candidate of resolveCompactionMethodOrder(input.order)) {
		if (!isMethodAvailable(candidate, input.availability)) {
			attempts.push({ method: candidate, outcome: "unavailable" });
			continue;
		}
		const reason = input.run(candidate);
		if (reason === undefined) {
			attempts.push({ method: candidate, outcome: "succeeded" });
			return { succeeded: candidate, attempts, exhausted: false };
		}
		attempts.push({ method: candidate, outcome: "failed", reason });
	}
	// Exhausted means every real method was tried and none succeeded, so the context
	// is still full. An order naming nothing real reaches the same state by having no
	// method left to try, so both report exhausted rather than reporting a pass that
	// never happened.
	return { exhausted: true, attempts };
}

/** A method worth showing a marker for, or undefined when there is nothing to show. */
export type SpeculationMethod = "remote" | "handoff" | "soft";

/**
 * The method a threshold pass would reach first, if it is worth speculating on.
 *
 * Local methods return `undefined`: they are effectively instant, so by the time
 * a marker could be drawn the compaction has already happened. Reporting them
 * would put a permanent mark on the context gauge for an operation with no
 * latency to warn about.
 *
 * `skipRemote` passes over server-native compaction, which is what a caller does
 * after it has failed for good — without that, every subsequent pass retries a
 * method already known to be broken.
 */
export function resolveSpeculationMethod(
	order: readonly string[],
	availability: MethodAvailability,
	{ skipRemote = false }: { skipRemote?: boolean } = {},
): SpeculationMethod | undefined {
	for (const candidate of resolveCompactionMethodOrder(order)) {
		if (skipRemote && candidate === "remote") continue;
		if (!isMethodAvailable(candidate, availability)) continue;
		if (candidate === "remote" || candidate === "handoff" || candidate === "soft") return candidate;
		// snapcompact and shake are local: nothing to speculate about.
		return undefined;
	}
	return undefined;
}
