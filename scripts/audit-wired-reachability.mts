/**
 * Reachability audit for the Settings parity ledger.
 *
 * ## Why this exists
 *
 * The ledger gate proves a row marked `wired` has a key that exists in the typed
 * registry. That is necessary and nowhere near sufficient: a descriptor with no
 * reader passes every check while the setting governs nothing. An audit on
 * 2026-09-30 found 223 of 249 `wired` rows in exactly that state.
 *
 * This script is the mechanical half of that finding. It answers one question —
 * does any source file outside the registry reference this row's key? — and
 * prints the rows for which the answer is no.
 *
 * ## What it deliberately does not decide
 *
 * A missing reference is evidence, not proof of absence. A row whose behaviour is
 * implemented through a different path, whose key is assembled at runtime, or
 * whose consumer lives outside the searched roots will show up here as an
 * orphan. Each candidate therefore needs reading before it is demoted; the script
 * narrows 249 rows to a reviewable list, it does not classify them.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-wired-reachability.mts
 *
 * Exits 0 always. A non-zero exit would mean a wired row lost its consumer,
 * which is a regression to investigate rather than a routine build failure.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Packages whose source can consume a setting. */
const CONSUMER_ROOTS = [
	"packages/ai/src",
	"packages/agent/src",
	"packages/coding-agent/src",
	"packages/tui/src",
	"packages/server/src",
];

/**
 * Files that only declare or describe settings.
 *
 * A key in one of these is a declaration, not a consumer, so including them
 * would make every row look reachable.
 */
const DECLARATION_ONLY = new Set([
	"settings-descriptors.ts",
	"settings-registry.ts",
	"settings-manager.ts",
	"settings-parity-rows.ts",
	"settings-parity-ledger.ts",
	"settings.ts",
]);

function collectSources(): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && !DECLARATION_ONLY.has(entry.name)) files.push(full);
		}
	};
	for (const relative of CONSUMER_ROOTS) walk(path.join(root, relative));
	return files;
}

// A file URL rather than a path: on Windows an absolute path is not a valid ESM
// specifier, and the dynamic import is needed because the rows module pulls in
// TypeScript sources the loader has to transform.
const { OMP_PARITY_ROWS } = await import(pathToFileURL(path.join(root, "packages/tui/src/overlays/settings-parity-rows.ts")).href);
const sources = collectSources();
const corpus = sources.map((file) => fs.readFileSync(file, "utf8"));
const wired = OMP_PARITY_ROWS.filter((row) => row.status === "wired" && row.piKey);

/** Whether any consumer-root source references this exact key string. */
const referenced = (key: string) => corpus.some((text) => text.includes(`"${key}"`));

const orphans = wired.filter((row) => !referenced(row.piKey!));

console.log(`consumer sources scanned: ${sources.length}`);
console.log(`rows marked wired:        ${wired.length}`);
console.log(`with a referenced key:    ${wired.length - orphans.length}`);
console.log(`declared but unreferenced: ${orphans.length}`);
if (orphans.length > 0) {
	console.log("\nEach of these has a registry key that no source file references.");
console.log("A missing reference is evidence, not proof: read each before demoting it.\n");
	for (const row of orphans) console.log(`  ${row.piKey}  (row ${row.id})`);
}
