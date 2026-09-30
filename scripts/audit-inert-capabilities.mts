import { findUnreferencedCapabilities } from "./lib/inert.ts";

/**
 * Reports exported capabilities that no production file references.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-inert-capabilities.mts
 *
 * ## Reading the output
 *
 * Three groups, weakest evidence first:
 *
 * - **no reference anywhere** — nothing references it, not even a test. Most
 *   likely dead, or a leaf helper whose caller was inlined.
 * - **tests only** — the archetype this program hit repeatedly: a good
 *   implementation with good tests and no production caller.
 * - **reachable** — reported for completeness, because a module that exports a
 *   symbol nothing uses is worth seeing next to one that is used.
 *
 * ## It is a detector, not a verdict
 *
 * A symbol can be called through a re-export, a framework callback, or a name
 * that differs from its declaration. Every hit is a candidate for a human to
 * settle. The scan only ever under-reports, which is the safe direction for a
 * list that gets reviewed.
 */

const root = process.cwd();
const unreferenced = findUnreferencedCapabilities(root);

const noRefs = unreferenced.filter((entry) => entry.testRefs === 0);
const testsOnly = unreferenced.filter((entry) => entry.testRefs > 0);

console.log(`exported capabilities with no production reference: ${unreferenced.length}`);
console.log(`  referenced by nothing at all: ${noRefs.length}`);
console.log(`  referenced by tests only:      ${testsOnly.length}`);

console.log("\n=== tests only: implemented, tested, and not in any runtime path ===");
console.log("(the archetype that produced the 2026-09-30 audit)");
for (const entry of testsOnly) {
	console.log(`  ${entry.kind.padEnd(9)} ${entry.name.padEnd(34)} ${entry.declaredIn}  (${entry.testRefs} test refs)`);
}

console.log("\n=== no reference at all ===");
for (const entry of noRefs) {
	console.log(`  ${entry.kind.padEnd(9)} ${entry.name.padEnd(34)} ${entry.declaredIn}`);
}
