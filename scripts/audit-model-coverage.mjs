#!/usr/bin/env node

// Audits a generated model catalog against the live, keyless upstream
// listings (OpenRouter, OpenCode Zen/Go) and models.dev. Generation applies
// the same rules minutes earlier, so a mismatch means the generator dropped
// models upstream still serves (the missing-free-models class a manual audit
// once caught) or kept models upstream delisted. Full coverage per listing is
// checked, which subsumes free-model coverage.
//
// Upstream fetch failures only warn and exit 0: a flaky endpoint must not
// block the publish pipeline. Real drift exits 1.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_INPUT = ".artifacts/model-catalog";
const OPENROUTER_LISTINGS = {
	chat: "https://openrouter.ai/api/v1/models",
	image: "https://openrouter.ai/api/v1/models?output_modalities=image",
	classifier: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
};
const OPENCODE_VARIANTS = [
	{ provider: "opencode", basePath: "https://opencode.ai/zen" },
	{ provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
];
const MODELS_DEV_URL = "https://models.dev/api.json";
// generate-models.ts hardcodes an `auto` alias for openrouter/auto; the alias
// id itself never appears in the live listing.
const STALE_EXEMPT_IDS = new Set(["auto"]);
// Mirrors the generator's opencode exclusion (generate-models.ts combine step).
const OPENCODE_EXCLUDED_IDS = new Set(["gpt-5.3-codex-spark"]);

function printUsage() {
	console.log(`Usage: node scripts/audit-model-coverage.mjs [--input <dir>]

Audits the generated model catalog against the live OpenRouter and OpenCode
listings plus models.dev metadata. Exits 1 on drift, 0 when clean or when an
upstream listing is unreachable.

Examples:
  npm run audit:model-catalog
  node scripts/audit-model-coverage.mjs --input .artifacts/model-catalog
`);
}

async function fetchJson(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return response.json();
}

// Catalog files come in two shapes: the published artifact ships
// providers/{id}.all.json as an array of entries with `type`, while the
// hydrated src/providers/data dir holds {id}.json nested under api groups as
// "<type>:<id>" keys.
function loadCatalogIds(inputDir, provider) {
	const candidates = [join(inputDir, "providers", `${provider}.all.json`), join(inputDir, `${provider}.json`)];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error(`missing catalog file: ${candidates.join(" or ")}`);
	const json = JSON.parse(readFileSync(path, "utf8"));
	const byType = new Map();
	const add = (type, id) => {
		if (!byType.has(type)) byType.set(type, new Set());
		byType.get(type).add(id);
	};
	if (Array.isArray(json)) {
		for (const entry of json) add(entry.type ?? "chat", entry.id);
		return byType;
	}
	for (const group of Object.values(json)) {
		if (!group || typeof group !== "object") continue;
		for (const innerKey of Object.keys(group)) {
			const separator = innerKey.indexOf(":");
			if (separator < 0) continue;
			add(innerKey.slice(0, separator), innerKey.slice(separator + 1));
		}
	}
	return byType;
}

function auditOpenRouter({ live, catalog, findings }) {
	const liveIds = new Set();
	for (const items of Object.values(live)) {
		for (const item of items) liveIds.add(item.id);
	}
	const catalogIds = new Set();
	for (const ids of catalog.values()) {
		for (const id of ids) catalogIds.add(id);
	}

	const expected = { chat: [], image: [], classifier: [] };
	for (const model of live.chat) {
		if (model.supported_parameters?.includes("tools")) expected.chat.push(model.id);
	}
	for (const model of live.image) {
		if (model.architecture?.output_modalities?.includes("image")) expected.image.push(model.id);
	}
	for (const model of live.classifier) {
		if (model.architecture?.output_modalities?.includes("decisions")) expected.classifier.push(model.id);
	}

	for (const type of Object.keys(expected)) {
		const ids = catalog.get(type) ?? new Set();
		for (const id of expected[type]) {
			if (!ids.has(id)) findings.push(`openrouter: ${type} model missing from catalog: ${id}`);
		}
	}
	for (const id of catalogIds) {
		if (!liveIds.has(id) && !STALE_EXEMPT_IDS.has(id)) {
			findings.push(`openrouter: catalog model no longer served upstream: ${id}`);
		}
	}
}

function auditOpenCode({ provider, liveIds, catalogIds, modelsDevModels, findings }) {
	for (const id of liveIds) {
		if (OPENCODE_EXCLUDED_IDS.has(id)) continue;
		// Without models.dev metadata the generator cannot emit the model
		// either (tool support and api mapping come from there); skip.
		const metadata = modelsDevModels?.get(id);
		if (metadata && metadata.tool_call !== true) continue;
		if (!metadata) continue;
		if (!catalogIds.has(id)) findings.push(`${provider}: live model missing from catalog: ${id}`);
	}
	for (const id of catalogIds) {
		if (!liveIds.has(id)) findings.push(`${provider}: catalog model no longer served upstream: ${id}`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		printUsage();
		return 0;
	}
	let input = DEFAULT_INPUT;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--input") {
			const value = args[++index];
			if (!value) throw new Error("--input requires a value");
			input = value;
		} else {
			printUsage();
			return 1;
		}
	}
	const inputDir = resolve(input);
	console.log(`Auditing model coverage in ${inputDir}`);

	const findings = [];
	const warnings = [];

	// OpenRouter: the three listings together form the generator's source set.
	let openRouterLive;
	try {
		openRouterLive = {};
		for (const [type, url] of Object.entries(OPENROUTER_LISTINGS)) {
			const data = await fetchJson(url);
			openRouterLive[type] = data.data ?? [];
		}
		const openRouterCatalog = loadCatalogIds(inputDir, "openrouter");
		auditOpenRouter({ live: openRouterLive, catalog: openRouterCatalog, findings });
		console.log(
			`openrouter: ${openRouterLive.chat.length + openRouterLive.image.length + openRouterLive.classifier.length} live listings, ${
				[...(openRouterCatalog.get("chat") ?? []), ...(openRouterCatalog.get("image") ?? []), ...(openRouterCatalog.get("classifier") ?? [])]
					.length
			} catalog ids`,
		);
	} catch (error) {
		warnings.push(`openrouter section skipped: ${error.message}`);
	}

	// OpenCode: live listing drives both directions; models.dev only gates
	// which live ids the generator is able to emit.
	let modelsDevModels;
	try {
		const modelsDev = await fetchJson(MODELS_DEV_URL);
		modelsDevModels = new Map(OPENCODE_VARIANTS.map(({ provider }) => [provider, new Map(Object.entries(modelsDev[provider]?.models ?? {}))]));
	} catch (error) {
		warnings.push(`models.dev unavailable, opencode missing-model checks skipped: ${error.message}`);
	}

	for (const { provider, basePath } of OPENCODE_VARIANTS) {
		try {
			const data = await fetchJson(`${basePath}/v1/models`);
			const liveIds = new Set((data.data ?? []).map((model) => model.id));
			if (liveIds.size === 0) throw new Error(`${basePath} returned no models`);
			const catalogIds = new Set([...(loadCatalogIds(inputDir, provider).get("chat") ?? [])]);
			auditOpenCode({
				provider,
				liveIds,
				catalogIds,
				modelsDevModels: modelsDevModels?.get(provider),
				findings,
			});
			console.log(`${provider}: ${liveIds.size} live models, ${catalogIds.size} catalog models`);
		} catch (error) {
			warnings.push(`${provider} section skipped: ${error.message}`);
		}
	}

	for (const warning of warnings) console.warn(`WARN: ${warning}`);
	if (findings.length > 0) {
		console.error(`\nModel coverage drift (${findings.length}):`);
		for (const finding of findings) console.error(`  ${finding}`);
		return 1;
	}
	console.log(warnings.length > 0 ? "No drift found (some sections skipped)." : "Model coverage audit passed.");
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
