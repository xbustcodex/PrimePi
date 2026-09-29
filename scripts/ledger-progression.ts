/**
 * The wired-row progression, derived from repository history.
 *
 * ## Why this file exists
 *
 * A progress report said "27 → 103 wired" while the mechanically reconciled
 * boundary immediately before it read 66. Both numbers cannot be the derived
 * count, and the ledger is the authority. Rather than guess which narrative
 * figure was intended, this walks every commit that touched the ledger and
 * counts what it actually said.
 *
 * ## The answer
 *
 * **11 → 103**, across 25 ledger changes. The "27" in the report heading matches
 * no step in the history. The 66 figure was correct at its commit; the ledger
 * then gained rows through the display, sampling, subagent, compaction, grep and
 * context work that followed.
 *
 * ## A measurement note worth keeping
 *
 * Counting keys with a quoted-only pattern undercounts, because an unquoted
 * identifier is a perfectly valid JavaScript object key. That produced 100 where
 * the true count was 103, and it briefly looked like three rows were missing
 * from the promotion table. They were not. The count must include both forms.
 */

import { execFileSync } from "node:child_process";

const LEDGER = "packages/tui/src/overlays/settings-parity-ledger.ts";

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Counts wired and live rows in a ledger revision, without checking it out. */
export function countLedgerRevision(revision: string): { wired: number; live: number } | undefined {
	let source: string;
	try {
		source = git("show", `${revision}:${LEDGER}`);
	} catch {
		return undefined;
	}
	const wired = source.match(/const WIRED_ROWS[\s\S]*?\n\};/)?.[0];
	const live = source.match(/const LIVE_VERIFIED[\s\S]*?\]\);/)?.[0];
	if (!wired) return undefined;
	return {
		// Both quoted and unquoted keys, because both are valid object keys and a
		// quoted-only pattern undercounts.
		wired: [...wired.matchAll(/^\t"?([A-Za-z_][A-Za-z0-9_.-]*)"?\s*:/gm)].length,
		live: live ? [...live.matchAll(/"([^"]+)"/g)].length : 0,
	};
}

export interface ProgressionStep {
	readonly hash: string;
	readonly subject: string;
	readonly wired: number;
	readonly live: number;
}

/** Every point at which the wired count changed, oldest first. */
export function wiredProgression(): ProgressionStep[] {
	const commits = git("log", "--reverse", "--format=%H\t%s", "--", LEDGER)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, ...rest] = line.split("\t");
			return { hash, subject: rest.join("\t") };
		});
	const steps: ProgressionStep[] = [];
	let previous: number | undefined;
	for (const commit of commits) {
		const counts = countLedgerRevision(commit.hash);
		if (!counts || counts.wired === previous) continue;
		steps.push({ ...counts, hash: commit.hash.slice(0, 10), subject: commit.subject });
		previous = counts.wired;
	}
	return steps;
}

/** The derived summary, for a report that must not guess. */
export function describeProgression(): string {
	const steps = wiredProgression();
	if (steps.length === 0) return "no ledger history";
	const first = steps[0]!;
	const last = steps.at(-1)!;
	return `${first.wired} → ${last.wired} wired across ${steps.length} ledger changes; ${last.live} live verified at HEAD`;
}
