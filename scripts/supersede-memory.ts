/**
 * Supersede a stored claim through the normal memory mechanism.
 *
 * A memory that is no longer true is not deleted - it is contradicted, so the
 * history stays retrievable and the correction stays visible. Hand-editing the
 * bank would leave the stale claim in place and hide that it was ever wrong.
 *
 * Usage: npx tsx scripts/supersede-memory.ts "<old claim substring>" "<new claim>" "<evidence>"
 */

import { SessionMemory } from "../packages/coding-agent/src/core/memory/session.ts";
import { bankStoreScoping } from "../packages/coding-agent/src/core/settings-descriptors.ts";
import type { BankScoping } from "../packages/coding-agent/src/core/memory/bank-scope.ts";

const [, , oldNeedle, replacement, evidence] = process.argv;
if (!oldNeedle || !replacement || !evidence) {
	console.error('usage: supersede-memory.ts "<old claim substring>" "<new claim>" "<evidence>"');
	process.exit(2);
}

const ROOT = "C:/Users/xkali/.primepi-agent/memory";
const CWD = "C:/Users/xkali/new_ai/pi";

const memory = await SessionMemory.create({
	backendId: "bank-store",
	bankStore: { root: ROOT, cwd: CWD, scoping: bankStoreScoping.descriptor.default as BankScoping },
	project: "primepi",
});

if (!memory.status.available) {
	console.error(`memory unavailable: ${memory.status.reason}`);
	process.exit(1);
}

const recalled = await memory.recall({ text: oldNeedle, limit: 20 });
const target = recalled.hits.find((hit) => hit.record.text.includes(oldNeedle));
if (!target) {
	console.error(`no stored memory matches: ${oldNeedle}`);
	console.error(`searched ${recalled.hits.length} hit(s) for: ${oldNeedle}`);
	process.exit(1);
}

console.log(`superseding: ${target.record.text.slice(0, 120)}`);

// The contradiction is recorded, and the corrected claim is retained. The old
// record stays on disk and stays retrievable; what changes is that the current
// state says otherwise, which is the same path any fact correction takes.
await memory.retain({
	type: "review",
	text: replacement,
	origin: { agent: "owner", source: "owner-correction" },
	project: "primepi",
	evidence,
});

console.log(`recorded:    ${replacement.slice(0, 120)}`);
console.log(`evidence:   ${evidence.slice(0, 120)}`);
await memory.stop();
