import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function runAudit(t, { catalog, upstream }) {
	const input = mkdtempSync(join(tmpdir(), "pi-audit-coverage-"));
	t.after(() => rmSync(input, { recursive: true, force: true }));
	const providersDir = join(input, "providers");
	mkdirSync(providersDir);
	for (const [provider, entries] of Object.entries(catalog)) {
		writeFileSync(join(providersDir, `${provider}.all.json`), `${JSON.stringify(entries)}\n`);
	}
	const preloadPath = join(input, "mock-upstream.mjs");
	writeFileSync(
		preloadPath,
		`const routes = ${JSON.stringify(upstream)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (!(url in routes)) throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`  const route = routes[url];\n` +
			`  if (route === "error") throw new Error("network down");\n` +
			`  return Response.json(route);\n` +
			`};\n`,
	);
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preloadPath).href, "scripts/audit-model-coverage.mjs", "--input", input],
		{ cwd: root, encoding: "utf8", timeout: 10_000 },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test("passes when the catalog matches the live listings", (t) => {
	const { status, output } = runAudit(t, {
		catalog: {
			openrouter: [
				{ type: "chat", id: "vendor/current" },
				{ type: "chat", id: "auto" },
				{ type: "image", id: "vendor/image-model" },
				{ type: "classifier", id: "typesafe/jev-latest" },
			],
			opencode: [{ type: "chat", id: "mimo-v2.5-free" }],
			"opencode-go": [{ type: "chat", id: "glm-5.2" }],
		},
		upstream: {
			"https://openrouter.ai/api/v1/models": {
				data: [
					{ id: "vendor/current", supported_parameters: ["tools"] },
					{ id: "vendor/no-tools" },
				],
			},
			"https://openrouter.ai/api/v1/models?output_modalities=image": {
				data: [{ id: "vendor/image-model", architecture: { output_modalities: ["image"] } }],
			},
			"https://openrouter.ai/api/v1/models?output_modalities=decisions": {
				data: [{ id: "typesafe/jev-latest", architecture: { output_modalities: ["decisions"] } }],
			},
			"https://models.dev/api.json": {
				opencode: {
					models: {
						"mimo-v2.5-free": { tool_call: true },
						"no-tool-model": { tool_call: false },
					},
				},
				"opencode-go": { models: { "glm-5.2": { tool_call: true } } },
			},
			// Live ids the generator cannot or must not emit stay excluded: no
			// tool support, no models.dev metadata, and the hardcoded
			// codex-spark exclusion. `auto` (the openrouter/auto alias) is in
			// the catalog but never appears in the live listing.
			"https://opencode.ai/zen/v1/models": {
				data: [
					{ id: "mimo-v2.5-free" },
					{ id: "no-tool-model" },
					{ id: "no-metadata-model" },
					{ id: "gpt-5.3-codex-spark" },
				],
			},
			"https://opencode.ai/zen/go/v1/models": { data: [{ id: "glm-5.2" }] },
		},
	});
	assert.equal(status, 0, output);
	assert.match(output, /Model coverage audit passed\./);
});

test("reports missing and stale models and exits 1", (t) => {
	const { status, output } = runAudit(t, {
		catalog: {
			openrouter: [{ type: "chat", id: "vendor/gone" }],
			opencode: [{ type: "chat", id: "zen-gone" }],
			"opencode-go": [{ type: "chat", id: "glm-5.2" }],
		},
		upstream: {
			"https://openrouter.ai/api/v1/models": {
				data: [
					{ id: "vendor/missing:free", supported_parameters: ["tools"] },
					{ id: "vendor/no-tools" },
				],
			},
			"https://openrouter.ai/api/v1/models?output_modalities=image": { data: [] },
			"https://openrouter.ai/api/v1/models?output_modalities=decisions": { data: [] },
			"https://models.dev/api.json": {
				opencode: { models: { "zen-new": { tool_call: true } } },
				"opencode-go": { models: { "glm-5.2": { tool_call: true } } },
			},
			"https://opencode.ai/zen/v1/models": { data: [{ id: "zen-new" }] },
			"https://opencode.ai/zen/go/v1/models": { data: [{ id: "glm-5.2" }] },
		},
	});
	assert.equal(status, 1, output);
	for (const finding of [
		"openrouter: chat model missing from catalog: vendor/missing:free",
		"openrouter: catalog model no longer served upstream: vendor/gone",
		"opencode: live model missing from catalog: zen-new",
		"opencode: catalog model no longer served upstream: zen-gone",
	]) {
		assert.ok(output.includes(finding), `${finding}\n${output}`);
	}
});

test("warns instead of failing when upstream listings are unreachable", (t) => {
	const { status, output } = runAudit(t, {
		catalog: { openrouter: [{ type: "chat", id: "vendor/current" }] },
		upstream: {
			"https://openrouter.ai/api/v1/models": "error",
			"https://openrouter.ai/api/v1/models?output_modalities=image": "error",
			"https://openrouter.ai/api/v1/models?output_modalities=decisions": "error",
			"https://models.dev/api.json": "error",
			"https://opencode.ai/zen/v1/models": "error",
			"https://opencode.ai/zen/go/v1/models": "error",
		},
	});
	assert.equal(status, 0, output);
	assert.match(output, /WARN:/);
	assert.match(output, /some sections skipped/);
});
