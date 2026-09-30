import fs from "node:fs";
import path from "node:path";

/**
 * Reports whether an integrated capability is present in the **built artifact**.
 *
 * ## Why this exists
 *
 * A capability can typecheck, pass behavioural tests driven through source, and
 * be absent from what ships. None of the existing gates would catch it: the
 * typecheck reads source, and the tests import source. Only the emitted
 * JavaScript answers the question.
 *
 * @MemoryRecall established the pattern while integrating auto-memory — it grepped
 * `dist/core/agent-session.js` for its own call site rather than trusting that a
 * passing test implied the code was there.
 *
 * ## What it does and does not prove
 *
 * A **present** symbol is evidence the integration shipped. An **absent** one is
 * evidence of a problem, not proof of one: the symbol may be inlined, renamed by
 * the bundler, or living in a chunk file this scan does not read.
 *
 * So the scan reports both directions and never asserts on absence. Treat a miss
 * as a prompt to look, exactly as the false-claim audit treats its candidates.
 *
 * Run from the repo root, after `npm run build`:
 *
 *     npx tsx scripts/audit-artifact-presence.mts <needle> [...]
 */

const NEEDLES = process.argv.slice(2);
if (NEEDLES.length === 0) {
	console.error("usage: npx tsx scripts/audit-artifact-presence.mts <needle> [...]");
	process.exit(2);
}

/** Built output directories, chunk files included. */
const ARTIFACT_ROOTS = [
	"packages/coding-agent/dist",
	"packages/agent/dist",
	"packages/ai/dist",
	"packages/tui/dist",
];

interface Root {
	readonly dir: string;
	readonly files: string[];
}

function collect(dir: string, out: string[] = []): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collect(full, out);
		else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

const roots: Root[] = ARTIFACT_ROOTS.filter((dir) => fs.existsSync(dir)).map((dir) => ({
	dir,
	files: collect(dir),
}));

if (roots.length === 0) {
	console.error("no build output found; run npm run build first");
	process.exit(2);
}

const total = roots.reduce((sum, root) => sum + root.files.length, 0);
console.log(`built artifacts scanned: ${total} files across ${roots.length} packages\n`);

for (const needle of NEEDLES) {
	const hits: string[] = [];
	for (const root of roots) {
		for (const file of root.files) {
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (text.includes(needle)) hits.push(path.relative(process.cwd(), file).replace(/\\/g, "/"));
		}
	}
	const verdict = hits.length > 0 ? "PRESENT in the shipped artifact" : "not found in built output";
	console.log(`${needle}`);
	console.log(`  ${verdict}`);
	for (const hit of hits.slice(0, 4)) console.log(`    ${hit}`);
	if (hits.length > 4) console.log(`    … and ${hits.length - 4} more`);
	console.log();
}

console.log("An absent needle is a prompt to look, not proof of a problem: the bundler");
console.log("may inline, rename, or place the symbol in a chunk this scan does read but");
console.log("under a different name. Confirm in the emitted file before concluding.");
