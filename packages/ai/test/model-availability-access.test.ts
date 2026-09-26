import { describe, expect, it } from "vitest";
import type { ApiKeyAuth, ProviderAuth } from "../src/auth/types.ts";
import { createModels, type Provider } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
		...extra,
	};
}

/** Provider whose credential never resolves: no key, no env, nothing. */
const missingKeyAuth: ApiKeyAuth = {
	name: "Missing key",
	resolve: async () => undefined,
};

function provider(id: string, models: Model<Api>[], auth: ProviderAuth = { apiKey: missingKeyAuth }): Provider {
	return {
		id,
		name: id,
		auth,
		getModels: () => models,
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
}

describe("getAvailable with credential-free models", () => {
	it("exposes anonymously served models from a provider with no credentials", async () => {
		const models = createModels();
		models.setProvider(
			provider("opencode", [
				model("opencode", "space-bunny-free", { free: true, access: "anonymous" }),
				model("opencode", "paid-model", { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }),
			]),
		);

		const available = await models.getAvailable();
		expect(available.map((m) => m.id)).toEqual(["space-bunny-free"]);
	});

	it("still hides every model on that provider when none is credential-free", async () => {
		const models = createModels();
		models.setProvider(
			provider("opencode", [
				model("opencode", "needs-login", { free: true }),
				model("opencode", "paid-model", { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }),
			]),
		);

		// `free: true` alone must not make a model reachable: this is the bug class
		// where price was mistaken for access.
		expect(await models.getAvailable()).toEqual([]);
	});

	it("returns all models of a credentialed provider, including its free ones", async () => {
		const models = createModels();
		models.setProvider(
			provider(
				"openrouter",
				[
					model("openrouter", "vendor/thing:free", { free: true }),
					model("openrouter", "vendor/paid", { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }),
				],
				{ apiKey: { name: "Key", resolve: async () => ({ auth: { apiKey: "sk-test" } }) } },
			),
		);

		expect((await models.getAvailable()).map((m) => m.id)).toEqual(["vendor/thing:free", "vendor/paid"]);
	});

	it("treats local models as reachable without credentials", async () => {
		const models = createModels();
		models.setProvider(provider("ollama", [model("ollama", "qwen2.5-coder:7b", { access: "local" })]));

		expect((await models.getAvailable()).map((m) => m.id)).toEqual(["qwen2.5-coder:7b"]);
	});

	it("does not treat an unknown access classification as credential-free", async () => {
		const models = createModels();
		models.setProvider(provider("mystery", [model("mystery", "m", { access: "unknown", free: true })]));

		expect(await models.getAvailable()).toEqual([]);
	});

	it("keeps providers independent: one anonymous model does not unlock the provider", async () => {
		const models = createModels();
		models.setProvider(
			provider("opencode", [
				model("opencode", "space-bunny-free", { free: true, access: "anonymous" }),
				model("opencode", "other-free", { free: true }),
			]),
		);

		// Only the anonymous one; the sibling free model still needs a login.
		expect((await models.getAvailable()).map((m) => m.id)).toEqual(["space-bunny-free"]);
	});
});
