/**
 * Provider protocol settings: the `providers.*` knobs that describe *how* a
 * request is sent, as opposed to *which* model answers it.
 *
 * ## Why these are resolved here and nowhere else
 *
 * Every session request is built by one function — `buildRequestOptions` in
 * `core/sdk.ts`, called by the `Agent`'s `streamFn` — and then handed to
 * `ModelRuntime.streamSimple`, which is the single place auth, disabled
 * providers, and credentials are settled. A protocol setting belongs in the
 * first of those and nowhere else, because a second place would be a second
 * answer to "what does this request look like", and the two would drift.
 *
 * ## What this module is not allowed to do
 *
 * It produces *transport* options only. It cannot name a model, cannot select a
 * provider, cannot add a credential, and cannot relax a gate: model eligibility
 * is `selectFailoverCandidate`'s, disabled-provider enforcement is
 * `ModelRuntime`'s, and paid/free policy is `policyAllowsPaid`'s. Every field
 * below is inert on its own — a longer cache TTL or a different transport says
 * nothing about which models are reachable.
 *
 * ## Why `auto` is not forwarded
 *
 * Three of these settings have a value that means "decide later" rather than a
 * value to send. `cacheRetention: "auto"` must leave the option unset so the
 * adapter's own `PI_CACHE_RETENTION` fallback still applies; `openrouterVariant:
 * "default"` must leave it unset because `:default` is not a real OpenRouter
 * variant and sending it would be a different request; `openaiWebsockets:
 * "auto"` must leave the caller's transport alone so an explicit choice is not
 * overwritten. Forwarding the token verbatim is the failure this file exists to
 * prevent.
 */

import type { CacheRetention, Model, SimpleStreamOptions, Transport } from "@earendil-works/pi-ai";
import { parseTimeoutSeconds, timeoutSecondsToMs } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Reads one registered setting by key.
 *
 * A function rather than a parsed settings object so the value still travels the
 * registry: `SettingsManager.getSetting` is the only path that validates and
 * layers. Anything constructed from an already-parsed object bypasses the same
 * parse a user's settings file goes through, which is how a setting ends up
 * testable but unwritable.
 */
export type ProtocolSettingReader = (key: string) => unknown;

/** The protocol options a request inherits from settings. */
export interface ProviderProtocolSettings {
	/** Unset means "let the adapter and `PI_CACHE_RETENTION` decide". */
	readonly cacheRetention?: CacheRetention;
	/** Unset means "keep whatever the caller chose". */
	readonly transport?: Transport;
	/** Never `"default"`: that is a setting token, not a wire variant. */
	readonly openrouterVariant?: string;
	readonly streamFirstEventTimeoutMs?: number;
	readonly streamIdleTimeoutMs?: number;
}

/** The wire value of an OpenRouter routing setting. */
function wireOpenRouterVariant(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	// The reference documents "default" as "no suffix". Sending `:default` would
	// ask OpenRouter for a variant that does not exist.
	if (trimmed.length === 0 || trimmed === "default") return undefined;
	return trimmed;
}

/** The wire value of the OpenAI transport setting. */
function wireTransport(value: unknown): Transport | undefined {
	if (value === "on") return "websocket";
	if (value === "off") return "sse";
	// "auto" leaves the caller's own transport in place.
	return undefined;
}

/**
 * Resolves the protocol settings from the registry.
 *
 * Read per request, not captured once: a transport or timeout changed mid
 * session must apply to the next request, which is the difference between a
 * setting and a launch flag.
 */
export function resolveProviderProtocolSettings(read: ProtocolSettingReader): ProviderProtocolSettings {
	const cacheRetention = read("providers.cacheRetention");
	const websockets = read("providers.openaiWebsockets");
	const variant = read("providers.openrouterVariant");
	const firstEvent = timeoutSecondsToMs(parseTimeoutSeconds(read("providers.streamFirstEventTimeoutSeconds")));
	const idle = timeoutSecondsToMs(parseTimeoutSeconds(read("providers.streamIdleTimeoutSeconds")));
	return {
		cacheRetention:
			cacheRetention === "auto" || cacheRetention === undefined
				? undefined
				: cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none"
					? cacheRetention
					: undefined,
		transport: wireTransport(websockets),
		openrouterVariant: wireOpenRouterVariant(variant),
		streamFirstEventTimeoutMs: firstEvent,
		streamIdleTimeoutMs: idle,
	};
}

/**
 * A reader bound to one session's settings manager.
 *
 * Exported so the integration point in `core/sdk.ts` is a one-liner and so a
 * test can obtain settings the way the session does.
 */
export function protocolSettingsReader(settingsManager: SettingsManager): ProtocolSettingReader {
	return (key) => settingsManager.getSetting(key)?.value;
}

/**
 * Whether a routing variant may be applied to this request at all.
 *
 * Gated on the host, not on the setting, because a `:suffix` is only valid on
 * OpenRouter: every other endpoint — including an OpenAI-compatible gateway that
 * happens to proxy one — would reject the id. The adapters check the host again
 * before touching the wire; two gates rather than one, because this is the layer
 * that decides what the options object claims and the adapter is the layer that
 * has seen the actual endpoint.
 */
function isOpenRouterTarget(model: Pick<Model<string>, "provider" | "baseUrl">): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
}

/**
 * Merges the protocol settings into one request's options.
 *
 * A caller-supplied value always wins. The settings fill holes; they never
 * overwrite an explicit choice, because the caller is the more specific
 * authority — a compaction request that pins its own cache identity must not
 * have it replaced by a session default.
 */
export function applyProviderProtocolSettings<TOptions extends SimpleStreamOptions>(
	options: TOptions,
	settings: ProviderProtocolSettings,
	model: Pick<Model<string>, "provider" | "baseUrl">,
): TOptions {
	const transport =
		options.transport === undefined || options.transport === "auto" ? settings.transport : options.transport;
	const openrouterVariant =
		options.openrouterVariant === undefined && isOpenRouterTarget(model) ? settings.openrouterVariant : undefined;
	return {
		...options,
		...(options.cacheRetention === undefined && settings.cacheRetention !== undefined
			? { cacheRetention: settings.cacheRetention }
			: {}),
		...(transport !== undefined && transport !== options.transport ? { transport } : {}),
		...(openrouterVariant !== undefined ? { openrouterVariant } : {}),
		...(options.streamFirstEventTimeoutMs === undefined && settings.streamFirstEventTimeoutMs !== undefined
			? { streamFirstEventTimeoutMs: settings.streamFirstEventTimeoutMs }
			: {}),
		...(options.streamIdleTimeoutMs === undefined && settings.streamIdleTimeoutMs !== undefined
			? { streamIdleTimeoutMs: settings.streamIdleTimeoutMs }
			: {}),
	};
}
