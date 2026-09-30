import { analyzeReachability } from "./lib/reachability.ts";
import { reconcileLedger, setConsumptionIndex } from "../packages/tui/src/overlays/settings-parity-ledger.ts";
import { OMP_PARITY_ROWS } from "../packages/tui/src/overlays/settings-parity-rows.ts";
import path from "node:path";

/**
 * Reports, per reference row, how far the settings-to-runtime chain is proven.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-settings-reachability.mts
 *
 * Exits 0 always. A non-zero exit would mean the analysis itself broke, which is
 * a different thing from a row being unreachable.
 */

const root = process.cwd();
const reach = analyzeReachability(root);

// Hand the measured index to the ledger so its evidence classes reflect what the
// repository actually does, rather than the conservative floor a bare test run sees.
const index = new Map(
	[...reach].map(([key, value]) => [key, value.edges.map((edge) => ({ site: edge.site, via: edge.via }))]),
);
setConsumptionIndex(index);

interface RowEvidence {
	readonly id: string;
	readonly registered: boolean;
	readonly referenceCount: number;
	readonly sites: readonly { site: string; via: string }[];
}

const wiredRows = OMP_PARITY_ROWS.filter((row) => row.status === "wired");
const evidence: RowEvidence[] = wiredRows.map((row) => {
	const key = row.piKey ?? row.id;
	const found = reach.get(key);
	return {
		id: row.id,
		registered: true,
		referenceCount: found?.edges.length ?? 0,
		sites: (found?.edges ?? []).map((edge) => ({ site: edge.site, via: edge.via })),
	};
});

const reachable = evidence.filter((row) => row.referenceCount > 0);
const unreachable = evidence.filter((row) => row.referenceCount === 0);

console.log(`reference rows:            ${OMP_PARITY_ROWS.length}`);
console.log(`rows declared wired:       ${wiredRows.length}`);
console.log(`  with a proven runtime path: ${reachable.length}`);
console.log(`  without one:                ${unreachable.length}`);

const byVia = new Map<string, number>();
for (const row of reachable) {
	for (const site of row.sites) {
		const id = `${site.via}|${site.site}`;
		byVia.set(id, (byVia.get(id) ?? 0) + 1);
	}
}

console.log("\n=== consumption sites, strongest first ===");
const ranked = [...byVia].sort((left, right) => right[1] - left[1]);
for (const [id, count] of ranked.slice(0, 18)) {
	const [via, site] = id.split("|");
	console.log(`  ${String(count).padStart(3)}  ${via.padEnd(11)} ${site}`);
}

console.log("\n=== rows with no proven runtime path ===");
for (const row of unreachable) console.log(`  ${row.id}`);

console.log("\n=== ledger evidence classes, with the measured index installed ===");
const summary = reconcileLedger();
for (const [name, count] of Object.entries(summary.byEvidence)) console.log(`  ${String(count).padStart(3)}  ${name}`);
console.log(`\n  unresolved (no proven path): ${unreachable.length}`);
console.log(`  invariants: unreconciled=${summary.unreconciled.length} registeredWithoutKey=${summary.registeredWithoutKey.length} liveWithoutBehaviour=${summary.liveWithoutBehaviour.length} reachableWithoutSite=${summary.reachableWithoutSite.length} liveWithoutSite=${summary.liveWithoutSite.length}`);
