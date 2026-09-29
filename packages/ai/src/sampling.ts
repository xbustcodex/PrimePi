/**
 * Sampling parameters: resolving a setting into what goes on the wire.
 *
 * ## The negative sentinel
 *
 * Every sampling setting defaults to **`-1`**, meaning *provider default*.
 *
 * That is not the same as a number, and conflating them is the whole failure
 * this module exists to prevent. Sending `temperature: 0` because the user never
 * set it produces a deterministic session the user did not ask for. Sending
 * `temperature: 1` because `undefined` was serialised as `null` produces a
 * creative one. Neither is what "unset" means.
 *
 * So the resolution is: **non-negative is a value, negative is absence**, and
 * absence is *omitted from the request* rather than defaulted. A provider that
 * has its own tuned default keeps it.
 *
 * ## Why a single rule for every parameter
 *
 * Temperature, `topP`, `topK`, `minP` and the penalties all use the same
 * sentinel, and they all have the same trap. A per-parameter exception is where
 * "why does topK get sent but topP does not" comes from, and the answer is
 * always a bug.
 *
 * ## What is still validated
 *
 * A value outside the parameter's valid range is rejected rather than clamped.
 * Clamping silently turns a typo into a different number, and the user has no
 * way to tell that happened.
 */

/** The sentinel meaning "the provider's own default". */
export const PROVIDER_DEFAULT = -1;

/** A sampling parameter and the range a provider accepts for it. */
export type SamplingParameter = "temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty";

/** The inclusive valid range for each parameter, where the provider defines one. */
export const SAMPLING_RANGES: Readonly<Record<SamplingParameter, { min: number; max: number } | undefined>> = {
	// Open-ended: providers accept values above 1, and the upper bound is not ours
	// to impose.
	temperature: { min: 0, max: Number.POSITIVE_INFINITY },
	topP: { min: 0, max: 1 },
	topK: { min: 0, max: Number.POSITIVE_INFINITY },
	minP: { min: 0, max: 1 },
	// Penalties are provider-specific and several accept values below zero, so no
	// bound is asserted rather than a wrong one.
	presencePenalty: undefined,
	repetitionPenalty: undefined,
};

/** The user's configured values, in the `-1` sentinel form. */
export type SamplingConfig = Readonly<Record<SamplingParameter, number>>;

/** Why a configured value was rejected. */
export type SamplingRejection = {
	readonly parameter: SamplingParameter;
	readonly reason: "out-of-range";
	readonly value: number;
	readonly range: string;
};

/** What goes on the wire: only the parameters the user actually set. */
export interface ResolvedSampling {
	readonly values: Readonly<Partial<Record<SamplingParameter, number>>>;
	readonly rejected: readonly SamplingRejection[];
}

/** The sentinel defaults, which is what an unconfigured session uses. */
export function defaultSamplingConfig(): SamplingConfig {
	return {
		temperature: PROVIDER_DEFAULT,
		topP: PROVIDER_DEFAULT,
		topK: PROVIDER_DEFAULT,
		minP: PROVIDER_DEFAULT,
		presencePenalty: PROVIDER_DEFAULT,
		repetitionPenalty: PROVIDER_DEFAULT,
	};
}

/**
 * Resolves one parameter.
 *
 * A negative value means absence and is *omitted*, not defaulted. A value
 * outside the provider's range is rejected rather than clamped, because clamping
 * silently turns a typo into a different number the user never chose.
 */
export function resolveParameter(
	parameter: SamplingParameter,
	value: number,
): { value?: number; rejection?: SamplingRejection } {
	if (!Number.isFinite(value) || value === PROVIDER_DEFAULT) return {};
	const range = SAMPLING_RANGES[parameter];
	if (range && (value < range.min || value > range.max)) {
		return {
			rejection: {
				parameter,
				reason: "out-of-range",
				value,
				range: range.max === Number.POSITIVE_INFINITY ? `at least ${range.min}` : `${range.min} to ${range.max}`,
			},
		};
	}
	// The sentinel is the only negative value that means absence. A parameter with
	// no declared range may legitimately accept a negative value, so the sentinel
	// check has to come after the range check rather than before it.
	if (value < 0) return {};
	return { value };
}

/**
 * Resolves the whole configuration, separating what is sent from what was
 * rejected.
 *
 * A rejected parameter is *dropped* rather than sent as-is: sending an
 * out-of-range value risks the provider rejecting the whole request, which turns
 * a typo in one setting into a failed turn.
 */
export function resolveSampling(config: SamplingConfig): ResolvedSampling {
	const values: Partial<Record<SamplingParameter, number>> = {};
	const rejected: SamplingRejection[] = [];
	for (const [parameter, configured] of Object.entries(config) as [SamplingParameter, number][]) {
		const outcome = resolveParameter(parameter, configured);
		if (outcome.rejection) rejected.push(outcome.rejection);
		else if (outcome.value !== undefined) values[parameter] = outcome.value;
	}
	return { values, rejected };
}

/**
 * The request fields, omitting anything the user did not set.
 *
 * A spread of the resolved values, which is an empty object when nothing was set:
 * a provider that sees no field uses its own, and one that sees `0` does not.
 */
export function toRequestFields(resolved: ResolvedSampling): Record<string, number> {
	return { ...resolved.values };
}

/** A one-line summary of what a session is sending, for a status line. */
export function describeSampling(resolved: ResolvedSampling): string {
	if (resolved.rejected.length > 0) {
		return `${resolved.rejected.length} sampling value(s) rejected: ${resolved.rejected.map((entry) => `${entry.parameter}=${entry.value} (${entry.reason})`).join(", ")}`;
	}
	const set = Object.entries(resolved.values);
	if (set.length === 0) return "sampling: provider defaults";
	return `sampling: ${set.map(([key, value]) => `${key}=${value}`).join(" ")}`;
}
