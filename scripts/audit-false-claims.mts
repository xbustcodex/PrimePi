import { analyzeReachability } from "./lib/reachability.ts";
import { OMP_PARITY_ROWS } from "../packages/tui/src/overlays/settings-parity-rows.ts";
import fs from "node:fs";

/**
 * Finds rows whose *evidence class* contradicts their *promotion claim*.
 *
 * ## Why this exists separately from the reachability audit
 *
 * `audit-wired-reachability.mts` reports capabilities with no production
 * reference. It answers "what code is inert". This answers a different and worse
 * question: **which claims in the ledger are currently false**.
 *
 * A row is a false claim when it is marked `wired` — or appears in
 * `LIVE_VERIFIED` — while the evidence model says it is not even
 * `runtime-reachable`. Those rows were promoted on intent: someone registered a
 * descriptor and wrote a note. The note described the design, not the code.
 *
 * ## What it does not claim
 *
 * "Not runtime-reachable" means no production path reads the key *by the forms
 * this analysis resolves* — a direct read, a typed accessor, a nested settings
 * path, or an injected reader. A parameterized accessor or an indirect policy
 * object is unresolvable statically, so a row can appear here and still be
 * genuinely wired. Every hit is a candidate to read, not a verdict.
 *
 * That direction is deliberate. The cost of a false positive is a human read; the
 * cost of a false negative is a row that claims integration it does not have and
 * that a progress report then repeats.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-false-claims.mts
 */

const root = process.cwd();
const reach = analyzeReachability(root);
const reachabilityByKey = new Map<string, number>();

const entries = OMP_PARITY_ROWS.map((row) => {
	const key = row.piKey ?? row.id;
	const sites = reach.get(key)?.edges.length ?? 0;
	reachabilityByKey.set(key, sites);
	return { row, key, sites };
});

// LIVE_VERIFIED is the strongest claim in the ledger. A row in it with no proven
// production read is asserting runtime verification of something nothing reads.
const ledgerSource = fs.readFileSync("packages/tui/src/overlays/settings-parity-ledger.ts", "utf8");
const liveVerified = new Set(
	[...liveVerifiedBlock(ledgerSource).matchAll(/"([^"]+)"/g)].map((match) => match[1]),
);

/** The LIVE_VERIFIED set literal, which spans many lines. */
function liveVerifiedBlock(source: string): string {
	return source.match(/const LIVE_VERIFIED[\s\S]*?\]\);/)?.[0] ?? "";
}

const falseClaims: { id: string; key: string; why: string }[] = [];
const weakened: { id: string; key: string; why: string }[] = [];

for (const { row, key, sites } of entries) {
	const promoted = row.status === "wired";
	if (promoted && sites === 0) {
		falseClaims.push({
			id: row.id,
			key,
			why: "marked wired, no proven production read",
		});
	}
	if (liveVerified.has(row.id) && sites === 0) {
		weakened.push({
			id: row.id,
			key,
			why: "in LIVE_VERIFIED, no proven production read",
		});
	}
}

console.log(`reference rows: ${OMP_PARITY_ROWS.length}`);
console.log(`rows with a proven production read: ${[...reachabilityByKey.values()].filter((count) => count > 0).length}`);
console.log(`\n=== false claims: promoted but unreachable (${falseClaims.length}) ===`);
for (const claim of falseClaims) console.log(`  ${claim.id.padEnd(42)} ${claim.why}`);

console.log(`\n=== live-verified but unreachable (${weakened.length}) ===`);
for (const claim of weakened) console.log(`  ${claim.id.padEnd(42)} ${claim.why}`);

console.log("\nEach entry is a candidate, not a verdict: a parameterized accessor or an");
console.log("indirect policy object is invisible to this analysis and would appear here");
console.log("as a false claim while being genuinely wired. Read before demoting.");
