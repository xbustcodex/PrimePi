import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function generateCatalog({
	modelsDevModels,
	liveIds,
	modelsDevProviders,
	keyedLiveIds,
	env,
}: {
	modelsDevModels: Record<string, unknown>;
	liveIds: string[] | "error";
	modelsDevProviders?: Record<string, { models: Record<string, unknown> }>;
	keyedLiveIds?: Record<string, string[] | "error">;
	env?: Record<string, string>;
}): Record<string, Record<string, Model<Api>>> {
	const root = mkdtempSync(join(tmpdir(), "pi-opencode-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	const catalog = { opencode: { models: modelsDevModels }, ...modelsDevProviders };
	const liveResponse =
		liveIds === "error"
			? `throw new Error("live catalog unavailable");`
			: `return Response.json({ data: ${JSON.stringify(liveIds.map((id) => ({ id })))} });`;
	const openRouterModels = [
		{ id: "vendor/paid-model", name: "Paid Model", supported_parameters: ["tools"] },
		{ id: "vendor/razor:free", name: "Razor Free", supported_parameters: ["tools"] },
	];
	const keyedRoutes = Object.entries(keyedLiveIds ?? {})
		.map(([routeUrl, ids]) => {
			const respond =
				ids === "error"
					? `throw new Error("keyed catalog unavailable");`
					: `return Response.json({ data: ${JSON.stringify(ids.map((id) => ({ id })))} });`;
			return `  if (url === ${JSON.stringify(routeUrl)}) { try { ${respond} } catch { return new Response("unavailable", { status: 503 }); } }\n`;
		})
		.join("");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
			`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000, output: 0 } } });\n` +
			`  if (url.startsWith("https://openrouter.ai/api/v1/models")) return Response.json({ data: ${JSON.stringify(openRouterModels)} });\n` +
			`  if (url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
			`  if (url === "https://opencode.ai/zen/v1/models") { try { ${liveResponse} } catch (error) { return new Response("unavailable", { status: 503 }); } }\n` +
			`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
			keyedRoutes +
			`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`};\n`,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{
			cwd: packageRoot,
			encoding: "utf8",
			timeout: 10_000,
			// Keyed probes must never fire from a developer's ambient environment.
			env: { ...process.env, TOGETHER_API_KEY: "", BASETEN_API_KEY: "", XIAOMI_API_KEY: "", ...env },
		},
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	const providersDir = join(outputPath, "providers");
	return Object.fromEntries(
		readdirSync(providersDir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => [
				basename(file, ".json"),
				JSON.parse(readFileSync(join(providersDir, file), "utf8")) as Record<string, Model<Api>>,
			]),
	);
}

describe("OpenCode model generation", () => {
	const toolModel = { tool_call: true, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };

	it("includes deprecated models the live endpoint still serves and drops delisted ones", () => {
		const { opencode: models } = generateCatalog({
			modelsDevModels: {
				// Deprecated in models.dev but still served live: a free Zen model.
				"mimo-v2.5-free": { ...toolModel, status: "deprecated" },
				// Deprecated and delisted: must stay excluded.
				"kimi-k2.5-free": { ...toolModel, status: "deprecated" },
				// Current in models.dev and served live.
				"space-bunny-free": { ...toolModel },
				// Current in models.dev but no longer served: must be dropped.
				"vanished-model": { ...toolModel },
			},
			liveIds: ["mimo-v2.5-free", "space-bunny-free"],
		});
		expect(Object.keys(models).sort()).toEqual(["mimo-v2.5-free", "space-bunny-free"]);
		expect(models["mimo-v2.5-free"].cost.input).toBe(0);
	});

	it("falls back to the models.dev deprecated flag when the live catalog is unreachable", () => {
		const { opencode: models } = generateCatalog({
			modelsDevModels: {
				"mimo-v2.5-free": { ...toolModel, status: "deprecated" },
				"space-bunny-free": { ...toolModel },
			},
			liveIds: "error",
		});
		expect(Object.keys(models)).toEqual(["space-bunny-free"]);
	});

	it("flags models with an explicit free-tier id marker, not zero cost", () => {
		// Both fixtures have zero cost; only the id suffix marks a free tier.
		const { opencode: opencodeModels, openrouter } = generateCatalog({
			modelsDevModels: {
				"mimo-v2.5-free": toolModel,
				"paid-model": toolModel,
			},
			liveIds: ["mimo-v2.5-free", "paid-model"],
		});
		expect(opencodeModels["mimo-v2.5-free"].free).toBe(true);
		expect(opencodeModels["paid-model"].free).toBeUndefined();
		expect(openrouter["vendor/razor:free"].free).toBe(true);
		expect(openrouter["vendor/paid-model"].free).toBeUndefined();
	});
});

describe("keyed provider live probes", () => {
	const toolModel = { tool_call: true, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };

	it("trusts the live listing over models.dev when a provider key is set", () => {
		const { together, baseten, xiaomi } = generateCatalog({
			modelsDevModels: {},
			liveIds: ["unused-opencode-model"],
			modelsDevProviders: {
				togetherai: {
					models: {
						// Flagged deprecated but still served live: kept.
						"vendor/kept-flagged": { ...toolModel, status: "deprecated" },
						// Current in models.dev but delisted live: dropped.
						"vendor/dropped-stale": toolModel,
						"vendor/kept-current": toolModel,
					},
				},
				baseten: {
					models: {
						"base/kept-flagged": { ...toolModel, status: "deprecated" },
						"base/dropped-stale": toolModel,
					},
				},
				xiaomi: {
					models: {
						"mimo-kept-flagged": { ...toolModel, status: "deprecated" },
						"mimo-dropped-stale": toolModel,
					},
				},
			},
			keyedLiveIds: {
				"https://api.together.ai/v1/models": ["vendor/kept-flagged", "vendor/kept-current"],
				"https://inference.baseten.co/v1/models": ["base/kept-flagged"],
				"https://api.xiaomimimo.com/v1/models": ["mimo-kept-flagged"],
			},
			env: { TOGETHER_API_KEY: "tg-test", BASETEN_API_KEY: "bt-test", XIAOMI_API_KEY: "xm-test" },
		});
		expect(Object.keys(together).sort()).toEqual(["vendor/kept-current", "vendor/kept-flagged"]);
		expect(Object.keys(baseten)).toEqual(["base/kept-flagged"]);
		expect(Object.keys(xiaomi)).toEqual(["mimo-kept-flagged"]);
	});

	it("falls back to the models.dev deprecated flag without a provider key", () => {
		const { together } = generateCatalog({
			modelsDevModels: {},
			liveIds: ["unused-opencode-model"],
			modelsDevProviders: {
				togetherai: {
					models: {
						"vendor/flagged": { ...toolModel, status: "deprecated" },
						"vendor/current": toolModel,
					},
				},
			},
		});
		expect(Object.keys(together)).toEqual(["vendor/current"]);
	});
});
