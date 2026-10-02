import path from "node:path";
/**
 * Reports the production capability graph.
 *
 * The model lives in `lib/capability-graph.ts`; this is the report. Run from the
 * repo root:
 *
 *     npx tsx scripts/audit-capability-graph.mts [substring]
 *
 * The three-way classification is the point:
 *
 *   reachable             a resolved call chain from a production root reaches it
 *   import-only           the module loads, nothing calls it
 *   behaviorally-inert    something calls it and throws the result away
 *   unreachable           no production file names it at all
 *
 * `behaviorally-inert` is the class none of the other audits detects, and it is
 * the one to read first: a capability there reports itself wired to every reader
 * of the source while governing nothing.
 */

import { buildCapabilityGraph } from "./lib/capability-graph.ts";

// Resolved from this file, not from the process cwd: an audit run from
// inside a package scanned that package, found nothing, and reported 0 - a
// confident negative for a tree it never looked at.
const ROOT = path.resolve(import.meta.dirname, "..");

const filter = process.argv[2];
const graph = buildCapabilityGraph(ROOT);

const shown = filter === undefined ? graph.nodes : graph.nodes.filter((node) => `${node.declaredIn}#${node.label}`.includes(filter));

console.log(`production roots: 3, modules in their value-import closure: ${graph.reachableModules.size}`);
console.log(`nodes: ${graph.nodes.length}, edges: ${graph.edges.length}`);

const groups = [
	["behaviorally-inert", "reached, result discarded — reports itself wired and governs nothing"],
	["import-only", "module loads, nothing calls it"],
	["unreachable", "no production file names it"],
	["reachable", "a resolved call chain reaches it"],
] as const;

for (const [classification, why] of groups) {
	const group = shown.filter((node) => node.classification === classification);
	console.log(`\n=== ${classification}: ${group.length} — ${why} ===`);
	const byFile = new Map<string, string[]>();
	for (const node of group) {
		const list = byFile.get(node.declaredIn) ?? [];
		list.push(`${node.label}${node.testRefs.length > 0 ? ` [t${node.testRefs.length}]` : ""}`);
		byFile.set(node.declaredIn, list);
	}
	for (const [file, names] of [...byFile].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0])).slice(0, 30)) {
		console.log(`  ${String(names.length).padStart(3)}  ${file}`);
		console.log(`       ${names.join(" ")}`);
	}
}

const needsEvidence = shown.filter((node) => node.evidence === "needs-behavioral-evidence");
console.log(`\nneeds behavioral evidence (final edge not statically decidable): ${needsEvidence.length}`);
console.log("A `reachable` node in that set has a proven call chain but no proof its result reaches output.");
console.log("A `unreachable` setting in that set is a claim with no read at all, which no runtime check can rescue.");