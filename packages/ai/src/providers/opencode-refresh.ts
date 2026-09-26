import type { RefreshModelsContext } from "../models.ts";
import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../types.ts";
import { withAccessFlag, withFreeFlag } from "../utils/free-model.ts";

/**
 * Runtime self-healing for the OpenCode Zen and Go catalogs.
 *
 * The generated baseline catalog only changes when pi is rebuilt, so models
 * that OpenCode launches upstream stay invisible until the next release and
 * models it delists stay listed. `createProvider({ fetchModels })` closes that
 * gap: every refresh reconciles the live `${basePath}/v1/models` listing into
 * a persisted overlay of live models that are missing from the baseline.
 *
 * The overlay only adds - `createProvider` unions it with the baseline, so a
 * baseline entry is never hidden at runtime, and the next generator run bakes
 * any provisional entry into the baseline with its id-specific patches. The
 * generator's `loadModelsDevData` opencode loop and the `gpt-5.3-codex-spark`
 * exclusion in `generateModels()` are the sources of truth for baseline
 * metadata; this file mirrors their generic mapping for ids the baseline does
 * not know yet. Keep the two in step.
 */

/** The models.dev entry fields needed to build a provisional OpenCode model. */
interface OpenCodeModelsDevModel {
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	provider?: { npm?: string };
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
}

export interface OpenCodeRefreshConfig<TApi extends Api = Api> {
	/** Provider id; doubles as the models.dev catalog key (`opencode`, `opencode-go`). */
	provider: "opencode" | "opencode-go";
	/** Zen or Zen Go API root; the live listing is `${basePath}/v1/models`. */
	basePath: string;
	/** Chat apis the provider's `api` map implements; live models mapping elsewhere are skipped. */
	apis: readonly TApi[];
	/** Ids of the generated baseline catalog; the overlay only adds live ids missing here. */
	baselineIds: ReadonlySet<string>;
}

/** Live listings are unauthenticated, as in the generator; empty means upstream trouble, not "no models". */
async function fetchLiveModelIds(basePath: string, signal: AbortSignal): Promise<Set<string>> {
	const response = await fetch(`${basePath}/v1/models`, { signal });
	if (!response.ok) throw new Error(`OpenCode API returned ${response.status}`);
	const data = (await response.json()) as { data?: { id?: string }[] };
	const modelIds = new Set((data.data ?? []).map((model) => model.id).filter((id): id is string => !!id));
	if (modelIds.size === 0) throw new Error("OpenCode API returned no models");
	return modelIds;
}

const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
/** models.dev metadata for new ids goes stale slowly; refetch at most once a day. */
const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsDevSnapshot {
	fetchedAt: number;
	models: Record<"opencode" | "opencode-go", Record<string, OpenCodeModelsDevModel>>;
}

// Only the two OpenCode catalogs are kept; the full api.json parse is transient.
let modelsDevSnapshot: ModelsDevSnapshot | undefined;

/** Test seam: forget the cached models.dev catalog. */
export function resetOpenCodeModelsDevCache(): void {
	modelsDevSnapshot = undefined;
}

async function loadModelsDevModels(
	provider: "opencode" | "opencode-go",
	signal: AbortSignal,
): Promise<Record<string, OpenCodeModelsDevModel>> {
	if (modelsDevSnapshot && Date.now() - modelsDevSnapshot.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
		return modelsDevSnapshot.models[provider];
	}
	const response = await fetch(MODELS_DEV_CATALOG_URL, { signal });
	if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
	const data = (await response.json()) as Record<string, { models?: Record<string, OpenCodeModelsDevModel> }>;
	modelsDevSnapshot = {
		fetchedAt: Date.now(),
		models: {
			opencode: data.opencode?.models ?? {},
			"opencode-go": data["opencode-go"]?.models ?? {},
		},
	};
	return modelsDevSnapshot.models[provider];
}

/**
 * Builds one provisional model from models.dev metadata with the same generic
 * npm-to-api mapping as the generator. Id-specific patches (grok-build,
 * kimi-k2.6, Go endpoint fixes, Google thinking maps) only exist for ids the
 * baseline already carries, so they are intentionally not reproduced here.
 */
function buildOpenCodeRuntimeModel<TApi extends Api>(
	config: OpenCodeRefreshConfig<TApi>,
	id: string,
	entry: OpenCodeModelsDevModel,
): Model<Api> | undefined {
	const npm = entry.provider?.npm;
	let api: Api;
	let baseUrl: string;
	let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

	if (npm === "@ai-sdk/openai") {
		api = "openai-responses";
		baseUrl = `${config.basePath}/v1`;
		compat = { sessionAffinityFormat: "openai-nosession" };
	} else if (npm === "@ai-sdk/anthropic") {
		api = "anthropic-messages";
		// Anthropic SDK appends /v1/messages to baseURL
		baseUrl = config.basePath;
	} else if (npm === "@ai-sdk/google") {
		api = "google-generative-ai";
		baseUrl = `${config.basePath}/v1`;
	} else if (npm === "@ai-sdk/alibaba") {
		api = "openai-completions";
		baseUrl = `${config.basePath}/v1`;
		compat = { cacheControlFormat: "anthropic" };
	} else {
		api = "openai-completions";
		baseUrl = `${config.basePath}/v1`;
	}
	if (!config.apis.some((supported) => supported === api)) return undefined;
	if (api === "openai-completions") {
		compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
	}

	return withAccessFlag(
		withFreeFlag<Model<Api>>({
			id,
			name: entry.name || id,
			api,
			provider: config.provider,
			baseUrl,
			reasoning: entry.reasoning === true,
			input: entry.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: entry.cost?.input || 0,
				output: entry.cost?.output || 0,
				cacheRead: entry.cost?.cache_read || 0,
				cacheWrite: entry.cost?.cache_write || 0,
			},
			...(compat ? { compat } : {}),
			contextWindow: entry.limit?.context || 4096,
			maxTokens: entry.limit?.output || 4096,
			type: "chat",
		}),
	);
}

/**
 * Pure reconciliation: live ids the baseline does not know, with metadata from
 * models.dev. Delisted ids, baseline ids, non-tool models, models without
 * metadata, and ids the generator excludes all drop out.
 */
export function selectOpenCodeRuntimeModels<TApi extends Api>(
	config: OpenCodeRefreshConfig<TApi>,
	liveIds: ReadonlySet<string>,
	modelsDevModels: Readonly<Record<string, OpenCodeModelsDevModel>>,
): Model<TApi>[] {
	const selected: Model<TApi>[] = [];
	for (const id of [...liveIds].sort()) {
		if (config.baselineIds.has(id)) continue;
		// Mirrors the generateModels() exclusion for both OpenCode providers.
		if (id === "gpt-5.3-codex-spark") continue;
		const entry = modelsDevModels[id];
		if (!entry || entry.tool_call !== true) continue;
		const model = buildOpenCodeRuntimeModel(config, id, entry);
		if (model) {
			// Safe: the `apis` guard above limits ids to the provider's dispatch map.
			selected.push(model as Model<TApi>);
		}
	}
	return selected;
}

/**
 * `fetchModels` implementation for the OpenCode providers. Returns the full
 * overlay on every successful refresh so previously added models stay
 * persisted while ids that went away upstream drop out again.
 */
export function createOpenCodeFetchModels<TApi extends Api>(
	config: OpenCodeRefreshConfig<TApi>,
): (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]> {
	return async (context: RefreshModelsContext): Promise<readonly Model<TApi>[]> => {
		const liveIds = await fetchLiveModelIds(config.basePath, context.signal);
		const hasUnknownLiveIds = [...liveIds].some((id) => !config.baselineIds.has(id));
		if (!hasUnknownLiveIds) return [];
		const modelsDevModels = await loadModelsDevModels(config.provider, context.signal);
		return selectOpenCodeRuntimeModels(config, liveIds, modelsDevModels);
	};
}
