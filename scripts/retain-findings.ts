/**
 * Retains findings from a completed migration boundary.
 *
 * The same discipline the seed script uses: a finding earns a place only if it
 * changes how something is built. Root causes, protocol and schema discoveries,
 * platform behaviour, rejected approaches, parity traps, verification debt. Not
 * progress narration.
 *
 * Usage: npx tsx scripts/retain-findings.ts <name>=<type>:<text>|<evidence>
 */

import { SessionMemory } from "../packages/coding-agent/src/core/memory/session.ts";
import { bankStoreScoping } from "../packages/coding-agent/src/core/settings-descriptors.ts";
import type { BankScoping } from "../packages/coding-agent/src/core/memory/bank-scope.ts";

const WORK_EVENT_TYPES = ["review", "test-run", "edit", "plan"] as const;
type WorkEventType = (typeof WORK_EVENT_TYPES)[number];

function parse(argument: string): { type: WorkEventType; text: string; evidence: string } | undefined {
	// <type>:<text>|<evidence>
	//
	// Both separators are found in the *first* segment: a claim may legitimately
	// contain a semicolon or a colon in its evidence, and treating the last pipe as
	// authoritative meant ordinary prose silently failed to parse. The first pipe is
	// the boundary because the type prefix never contains one.
	const firstSeparator = argument.indexOf(":");
	const lastPipe = argument.indexOf("|", firstSeparator);
	if (firstSeparator <= 0 || lastPipe <= firstSeparator) return undefined;
	const type = argument.slice(0, firstSeparator);
	const text = argument.slice(firstSeparator + 1, lastPipe).trim();
	const evidence = argument.slice(lastPipe + 1).trim();
	if (text.length === 0 || evidence.length === 0) return undefined;
	if (!(WORK_EVENT_TYPES as readonly string[]).includes(type)) return undefined;
	return { type: type as WorkEventType, text, evidence };
}

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0) {
	console.error("usage: retain-findings.ts <type>:<text>|<evidence> ...");
	process.exit(2);
}

const memory = await SessionMemory.create({
	backendId: "bank-store",
	bankStore: {
		root: "C:/Users/xkali/.primepi-agent/memory",
		cwd: "C:/Users/xkali/new_ai/pi",
		scoping: bankStoreScoping.descriptor.default as BankScoping,
	},
	project: "primepi",
});

if (!memory.status.available) {
	console.error(`memory unavailable: ${memory.status.reason}`);
	process.exit(1);
}

for (const argument of arguments_) {
	const finding = parse(argument);
	if (!finding) {
		console.error(`skipped (bad format): ${argument.slice(0, 60)}`);
		continue;
	}
	await memory.retain({
		type: finding.type,
		text: finding.text,
		origin: { agent: "primepi", source: "migration" },
		project: "primepi",
		evidence: finding.evidence,
	});
	console.log(`retained [${finding.type}] ${finding.text.slice(0, 90)}`);
}

const check = await memory.recall({ text: arguments_.join(" ").slice(0, 60) });
console.log(`\n${check.hits.length} hit(s) now recall for that text`);
await memory.stop();
