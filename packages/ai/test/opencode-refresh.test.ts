import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider, type RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import {
	createOpenCodeFetchModels,
	type OpenCodeRefreshConfig,
	resetOpenCodeModelsDevCache,
	selectOpenCodeRuntimeModels,
} from "../src/providers/opencode-refresh.ts";
import type { Api, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const zenConfig: OpenCodeRefreshConfig = {
	provider: "opencode",
	basePath: "https://opencode.ai/zen",
	apis: ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"],
	baselineIds: new Set(["known-model"]),
};

function refreshContext(): RefreshModelsContext {
	return {
		allowNetwork: true,
		publish: async () => true,
		signal: new AbortController().signal,
	};
}

function baselineModel(): Model<Api> {
	return {
		id: "known-model",
		name: "Known Model",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 1000,
		type: "chat",
	};
}

describe("OpenCode runtime catalog refresh", () => {
	beforeEach(() => {
		resetOpenCodeModelsDevCache();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetOpenCodeModelsDevCache();
	});

	it("selects only live ids the baseline is missing, with generator-equivalent metadata", () => {
		const modelsDev = {
			"known-model": { tool_call: true },
			"brand-new": {
				name: "Brand New",
				tool_call: true,
				reasoning: true,
				provider: { npm: "@ai-sdk/anthropic" },
				modalities: { input: ["text", "image"] },
				cost: { input: 1.5, output: 9, cache_read: 0.15, cache_write: 1.8 },
				limit: { context: 200000, output: 64000 },
			},
			"brand-new-free": { tool_call: true, provider: { npm: "@ai-sdk/openai" } },
			"paid-no-tool": { tool_call: false },
			"not-live": { tool_call: true },
			"gpt-5.3-codex-spark": { tool_call: true },
		};
		const liveIds = new Set([
			"known-model",
			"brand-new",
			"brand-new-free",
			"paid-no-tool",
			"gpt-5.3-codex-spark",
			"ghost-model",
		]);

		const selected = selectOpenCodeRuntimeModels(zenConfig, liveIds, modelsDev);

		expect(selected.map((model) => model.id)).toEqual(["brand-new", "brand-new-free"]);
		const [anthropicModel, responsesModel] = selected;
		expect(anthropicModel).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/zen",
			name: "Brand New",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.8 },
			contextWindow: 200000,
			maxTokens: 64000,
			type: "chat",
		});
		expect(anthropicModel.free).toBeUndefined();
		expect(responsesModel).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
			cost: { input: 0, output: 0 },
			contextWindow: 4096,
		});
		expect(responsesModel.free).toBe(true);
	});

	it("skips models whose api the provider cannot dispatch", () => {
		const goConfig: OpenCodeRefreshConfig = {
			provider: "opencode-go",
			basePath: "https://opencode.ai/zen/go",
			apis: ["anthropic-messages", "openai-completions", "openai-responses"],
			baselineIds: new Set(),
		};
		const modelsDev = { "google-only": { tool_call: true, provider: { npm: "@ai-sdk/google" } } };

		const selected = selectOpenCodeRuntimeModels(goConfig, new Set(["google-only"]), modelsDev);

		expect(selected).toEqual([]);
	});

	it("consults models.dev only when live ids are missing from the baseline", async () => {
		let liveIds = ["known-model"];
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			requested.push(url);
			if (url === "https://opencode.ai/zen/v1/models") {
				return Response.json({ data: liveIds.map((id) => ({ id })) });
			}
			if (url === "https://models.dev/api.json") {
				return Response.json({ opencode: { models: { "new-upstream": { tool_call: true } } } });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		const fetchModels = createOpenCodeFetchModels(zenConfig);

		await expect(fetchModels(refreshContext())).resolves.toEqual([]);
		expect(requested).toEqual(["https://opencode.ai/zen/v1/models"]);

		liveIds = ["known-model", "new-upstream"];
		const overlay = await fetchModels(refreshContext());
		expect(overlay.map((model) => model.id)).toEqual(["new-upstream"]);
		expect(requested).toEqual([
			"https://opencode.ai/zen/v1/models",
			"https://opencode.ai/zen/v1/models",
			"https://models.dev/api.json",
		]);
	});

	it("self-heals the provider catalog when upstream adds and delists models", async () => {
		let liveIds = ["known-model", "mimo-v2.5-free"];
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			if (url === "https://opencode.ai/zen/v1/models") {
				return Response.json({ data: liveIds.map((id) => ({ id })) });
			}
			if (url === "https://models.dev/api.json") {
				return Response.json({
					opencode: { models: { "known-model": { tool_call: true }, "mimo-v2.5-free": { tool_call: true } } },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("opencode", async () => ({ type: "api_key", key: "key" }));
		const models = createModels({ credentials, modelsStore: new InMemoryModelsStore() });
		models.setProvider(
			createProvider({
				id: "opencode",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "key" } }) } },
				models: [baselineModel()],
				fetchModels: createOpenCodeFetchModels(zenConfig),
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			}),
		);

		expect((await models.refresh()).errors.size).toBe(0);
		const added = models.getModel("opencode", "mimo-v2.5-free");
		expect(added?.free).toBe(true);

		// Upstream delists the model: the overlay drops it, the baseline stays.
		liveIds = ["known-model"];
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModel("opencode", "mimo-v2.5-free")).toBeUndefined();
		expect(models.getModel("opencode", "known-model")).toBeDefined();
	});
});
