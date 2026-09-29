/**
 * Seed the project's durable memory with findings from the migration so far.
 *
 * Idempotent: the pipeline deduplicates, so running this twice stores nothing
 * the second time. Only findings that changed how something is built are
 * included - a root cause, a protocol discovery, a platform fact, a rejected
 * approach. Progress narration is not knowledge and is deliberately absent.
 *
 * Run: npx tsx scripts/seed-project-memory.ts
 */

import { SessionMemory } from "../packages/coding-agent/src/core/memory/session.ts";
import { bankStoreName, bankStorePath, bankStoreScoping } from "../packages/coding-agent/src/core/settings-descriptors.ts";
import type { BankScoping } from "../packages/coding-agent/src/core/memory/bank-scope.ts";

const CWD = "C:/Users/xkali/new_ai/pi";

/** A finding, with the evidence that makes it weighable. */
interface Finding {
	readonly type: "review" | "root-cause" | "test-run";
	readonly text: string;
	readonly evidence: string;
	readonly source: string;
}

const FINDINGS: readonly Finding[] = [
	{
		type: "root-cause",
		text: "A surrounding or newly added .git marker must not change a project bank identity, because the upstream derivation once resolved the enclosing git root and stranded every memory a directory held when the marker appeared or disappeared",
		evidence: "oh-my-pi packages/coding-agent/test/mnemopi-bank-derivation.test.ts regression #2412; primepi bank-scope.ts resolveProjectRoot",
		source: "bank-scope",
	},
	{
		type: "review",
		text: "A sanitized basename is not a project identity, so two directories named api on different absolute paths must resolve to different banks or one project recalls another project's facts",
		evidence: "bank-scope.ts projectBankSegment appends a hash of the absolute path",
		source: "bank-scope",
	},
	{
		type: "review",
		text: "A legacy or rescue bank is read only when every one of its rows carries the active project path, and a mixed bank is skipped whole rather than partially read",
		evidence: "bank-store.ts bankOnlyHasCwd; the store cannot filter rows by project so a partial read leaks",
		source: "bank-store",
	},
	{
		type: "root-cause",
		text: "Opening a SQLite database that does not exist creates it, so a rescue probe must stat the file before opening it or inspection silently brings banks into existence",
		evidence: "bank-store.ts bankOnlyHasCwd file check; test asserts no bank.db appears",
		source: "bank-store",
	},
	{
		type: "review",
		text: "The IAI Personal stdio server entry point is iai_mcp.core:main, and iai_mcp.cli:main is the operator CLI which parses subcommands and would consume a JSON-RPC line as an argument",
		evidence: "iai_mcp/core/__init__.py line 1978 reads newline-delimited JSON-RPC from stdin",
		source: "pd9-trace",
	},
	{
		type: "review",
		text: "The IAI Personal engine has no initialize handshake and dispatches a fixed set of method names, so an MCP-style handshake probe fails against a healthy engine and a real method must be used as the liveness check",
		evidence: "iai_mcp/core/__init__.py dispatch at line 276 enumerates the method names",
		source: "pd9-trace",
	},
	{
		type: "review",
		text: "The IAI Personal engine encrypts its SQLite store and HNSW index at rest but writes a derived markdown cache holding record text in plaintext, so a blanket claim that every file under the store root is encrypted is false",
		evidence: "PD-9 proof scanned raw store bytes for a captured marker; the marker is absent from brain.sqlite3 and records.hnsw and present in .working-tier.-.cached.md",
		source: "pd9-proof",
	},
	{
		type: "review",
		text: "The IAI Personal engine refuses to open a store with no crypto key, and iai-mcp crypto init is its documented fresh-install bootstrap which creates a 32-byte key inside the store root",
		evidence: "iai_mcp/crypto.py raises CryptoKeyError naming the file and the command",
		source: "pd9-proof",
	},
	{
		type: "root-cause",
		text: "Memory deduplication must use containment of the smaller significant-word set rather than a symmetric ratio, because a ratio punishes a reworded fact for every word it phrases differently and stores one correction as two records",
		evidence: "retention.ts isSameFact; 'a fixed method set' against 'a fixed set of methods' scores 0.83 against a 0.85 threshold",
		source: "retention",
	},
	{
		type: "root-cause",
		text: "Differing numeric literals must make two memory claims distinct because the number is the claim, and deduplicating a corrected value against a stale one silently keeps the stale value",
		evidence: "retention.ts numbersIn; 'cooldown is 30 seconds' against 'cooldown is 90 seconds' shares every significant word",
		source: "retention",
	},
	{
		type: "review",
		text: "The IAI Personal project declares twelve runtime dependencies and the earlier trace that named only three was wrong, so dependency metadata must be read from pyproject.toml rather than inferred from an import error",
		evidence: "iai-personal-memory-engine pyproject.toml; cryptography and keyring are load-bearing for any encryption claim",
		source: "pd9-install",
	},
	{
		type: "review",
		text: "On Windows a spawnSync-based test suite times out under full parallel load and reports between 86 and 96 failures, so a full-suite failure count is not a regression signal on this machine and the same files fail at an earlier commit",
		evidence: "PD-10; measured at commit 377febaa5 before the retention work",
		source: "pd10",
	},
	{
		type: "review",
		text: "A process-wide backend configuration must merge rather than replace, because a session supplying an agent directory would otherwise discard engine settings that startup already installed and the symptom is a backend that quietly stops finding its own files",
		evidence: "registry.ts configurePrimePiBackends; the first implementation replaced the object wholesale",
		source: "registry",
	},
	{
		type: "root-cause",
		text: "A memory store must not fall back to the working directory for its storage root, because a session launched from a repository would write a memory directory into it and eventually commit it",
		evidence: "registry.ts local-store reports unavailable when no agent directory is configured; a memory/ directory appeared in the repository root during testing",
		source: "registry",
	},
	{
		type: "root-cause",
		text: "Memory deduplication must check for conflicts before any similarity score, because similarity is exactly what misleads when a corrected entry point or setting key differs from the stale one by a single token",
		evidence: "retention.ts conflictsWith runs before the containment score; iai_mcp.core:main against iai_mcp.cli:main scored a 0.9 word match",
		source: "dedup-adversarial",
	},
	{
		type: "root-cause",
		text: "A process-wide backend configuration merge that silently omits one backend key produces a store with no root, and the symptom names neither the missing field nor the caller that omitted it",
		evidence: "registry.ts configurePrimePiBackends omitted the bankStore merge line; the descriptor still resolved so inspection found nothing",
		source: "registry",
	},
	{
		type: "review",
		text: "Antonym and route-name lists in memory deduplication must stay short and closed, because a large table reports near-antonyms as contradictions and a store that never deduplicates accumulates the same fact forever",
		evidence: "retention.ts ANTONYMS and ROUTE_NAMES are closed lists; the three merge-still-works cases are the guard against over-splitting",
		source: "dedup-adversarial",
	},
	{
		type: "root-cause",
		text: "A configured compaction request budget may only lower an agent bundled ceiling and never raise it, because a settings screen that could raise a subagent above its designed cap would run it in a mode nobody tested",
		evidence: "task/budget.ts resolveSoftRequestBudget takes the tighter of the two; scout and sonic cap at 100 while default caps at 200",
		source: "migration",
	},
	{
		type: "decision",
		text: "Context maintenance advances past an unavailable method rather than failing the turn, because a maintenance method that cannot run must not take the session down with it",
		evidence: "compaction/trigger.ts selectCompactionMethod walks the order and reports every failure rather than continuing with a full context",
		source: "migration",
	},
	{
		type: "root-cause",
		text: "A compaction token limit overrides a percentage threshold, because a percentage that would have fired later must not override an absolute limit the user typed",
		evidence: "compaction/trigger.ts resolveCompactionThreshold prefers the token source, and falls back to the reserve when neither is set",
		source: "migration",
	},];

const backendId = "bank-store";
const memory = await SessionMemory.create({
	backendId,
	bankStore: {
		root: "C:/Users/xkali/.primepi-agent/memory",
		cwd: CWD,
		// The registry exposes defaults on the descriptor; there is no resolved-value
		// getter yet, and a settings-manager-backed lookup belongs in the wiring that
		// the settings row activates, not in a seed script.
		...(bankStoreName.descriptor.default ? { bank: bankStoreName.descriptor.default } : {}),
		...(bankStoreScoping.descriptor.default ? { scoping: bankStoreScoping.descriptor.default as BankScoping } : {}),
	},
	project: "primepi",
});

console.log(`status: ${memory.status.summary}`);
if (!memory.status.available) {
	console.error(`memory unavailable: ${memory.status.reason}`);
	process.exit(1);
}

for (const finding of FINDINGS) {
	await memory.retain({
		type: finding.type,
		text: finding.text,
		origin: { agent: "primepi", source: finding.source },
		project: "primepi",
		evidence: finding.evidence,
	});
}

const recalled = await memory.recall({ text: "memory bank isolation dedup encryption IAI protocol" });
console.log(`\nseeded ${FINDINGS.length} findings; ${recalled.hits.length} recalled`);
console.log(`db path override: ${bankStorePath.descriptor.default || "(default: agent directory)"}`);
for (const hit of recalled.hits.slice(0, 4)) {
	console.log(`  - [${hit.record.kind}/${hit.record.provenance.source}] ${hit.record.text.slice(0, 96)}`);
}
await memory.stop();
