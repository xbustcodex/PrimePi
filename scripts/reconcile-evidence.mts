import { analyzeReachability } from "./lib/reachability.ts";
import {
	buildLedger,
	type EvidenceClass,
	reconcileLedger,
	setConsumptionIndex,
} from "../packages/tui/src/overlays/settings-parity-ledger.ts";
import { OMP_PARITY_ROWS } from "../packages/tui/src/overlays/settings-parity-rows.ts";

/**
 * Reconciles every evidence set from one repository state and prints the
 * differences between them.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/reconcile-evidence.mts
 *
 * ## Why this exists
 *
 * A report once stated "16 runtime-reachable, 17 behaviourally-verified" alongside
 * the enforced invariant `behaviourally-verified ⊆ runtime-reachable`. Those cannot
 * both hold over the same universe, so one of the two numbers was measuring
 * something else. Rather than adjust a figure to look consistent, this derives
 * every set from the same pass and prints each difference explicitly — so a
 * disagreement is visible as a list of ids rather than as two integers that look
 * plausible in isolation.
 */

const root = process.cwd();
const reach = analyzeReachability(root);
const index = new Map([...reach].map(([key, value]) => [key, value.edges.map((edge) => ({ site: edge.site, via: edge.via }))]));
setConsumptionIndex(index);

const entries = buildLedger();
const summary = reconcileLedger();

/**
 * Rows asserting a class, as ids.
 *
 * Read from `claims` — the cumulative set — rather than `evidence`, which is only the
 * strongest claim a row makes. Reading the wrong one is what produced the original
 * contradiction: `evidence` is mutually exclusive, `claims` is not.
 */
const idsOf = (cls: EvidenceClass): string[] =>
	entries.filter((entry) => entry.claims.includes(cls)).map((entry) => entry.id).sort();
const registered = new Set(idsOf("registered"));
const reachable = new Set(idsOf("runtime-reachable"));
const behavioural = new Set(idsOf("behaviourally-verified"));
const live = new Set(idsOf("live-verified"));

const difference = (left: Set<string>, right: Set<string>): string[] => [...left].filter((id) => !right.has(id)).sort();

console.log("=== evidence universe ===");
// Nested sets, so they do NOT sum to the row total; every row asserts exactly one
// of unregistered or registered, and may assert up to three more.
const classTotal = (
	["unregistered", "registered", "implemented", "runtime-reachable", "behaviourally-verified", "live-verified"] as const
).reduce((sum, cls) => sum + summary.byEvidence[cls], 0);
console.log(`rows classified:            ${entries.length}`);
console.log(`total class assertions:      ${classTotal} (nested, so > rows)`);
console.log(`rows with status "wired":    ${OMP_PARITY_ROWS.filter((row) => row.status === "wired").length}`);
console.log(`rows total (all statuses):   ${OMP_PARITY_ROWS.length}`);
console.log(`promoted (historical claim): ${entries.filter((entry) => entry.promoted !== undefined).length}`);

console.log("\n=== counts ===");
for (const cls of ["unregistered", "registered", "implemented", "runtime-reachable", "behaviourally-verified", "live-verified"] as const) {
	console.log(`  ${String(summary.byEvidence[cls]).padStart(4)}  ${cls}`);
}

console.log("\n=== differences (each must be empty for the subset invariant to hold) ===");
const show = (label: string, ids: string[]) => {
	console.log(`  ${label}: ${ids.length}`);
	for (const id of ids) console.log(`      ${id}`);
};
show("behaviourally-verified MINUS runtime-reachable", difference(behavioural, reachable));
show("live-verified MINUS behaviourally-verified", difference(live, behavioural));
show("runtime-reachable MINUS registered", difference(reachable, registered));

console.log("\n=== independent cross-check: reachability measured directly ===");
// Counted from the analysis output rather than the ledger, so a bug in the
// ladder cannot hide behind the ledger agreeing with itself.
const directlyReachable = OMP_PARITY_ROWS.filter((row) => row.status === "wired" && (index.get(row.piKey ?? row.id)?.length ?? 0) > 0).length;
console.log(`  wired rows with a proven production read: ${directlyReachable}`);
console.log(`  ledger runtime-reachable:                 ${summary.byEvidence["runtime-reachable"]}`);
console.log(`  agreement:                                ${directlyReachable === summary.byEvidence["runtime-reachable"] ? "yes" : "NO — the ledger ladder disagrees with the analysis"}`);

console.log("\n=== invariants ===");
console.log(`  unreconciled:          ${summary.unreconciled.length}`);
console.log(`  registeredWithoutKey: ${summary.registeredWithoutKey.length}`);
console.log(`  liveWithoutBehaviour: ${summary.liveWithoutBehaviour.length}`);
console.log(`  reachableWithoutSite: ${summary.reachableWithoutSite.length}`);
console.log(`  liveWithoutSite:      ${summary.liveWithoutSite.length}`);
