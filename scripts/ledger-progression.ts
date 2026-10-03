import path from "node:path";
/**
 * The promoted-row progression, derived from repository history.
 *
 * ## Why this exists
 *
 * A progress report once said "27 → 103 wired" while the mechanically reconciled
 * boundary before it read 66. Rather than guess which narrative number was
 * intended, the progression is derived from git and asserted by a test.
 *
 * ## Why it counts *promotions*, not integrations
 *
 * Before September 2026 this counted `WIRED_ROWS`, a table of notes describing
 * which consumer *should* read each key. A reachability audit then found 223 of
 * 249 rows so named had no consumer at all, so the count measured intent.
 *
 * The field survives under the name `promoted`, and so does the history: knowing
 * how many rows were *claimed* migrated is worth keeping, and knowing it was
 * claimed is not the same as knowing it was. Runtime reachability is measured
 * separately by `scripts/audit-settings-reachability.mts`, which reads the
 * repository rather than a table.
 */

import { execFileSync } from "node:child_process";

// Resolved from this file, not from the process cwd: an audit run from
// inside a package scanned that package, found nothing, and reported 0 - a
// confident negative for a tree it never looked at.
const ROOT = path.resolve(import.meta.dirname, "..");

const LEDGER = "packages/tui/src/overlays/settings-parity-ledger.ts";

const gitCache = new Map<string, string>();

function git(...args: string[]): string {
	const id = args.join(" ");
	const cached = gitCache.get(id);
	if (cached !== undefined) return cached;
	try {
		const out = execFileSync("git", args, {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		gitCache.set(id, out);
		return out;
	} catch {
		// A path absent at this revision is a normal answer, not a failure.
		throw new Error("git read failed");
	}
}

/**
 * Counts promoted and live rows in a ledger revision, without checking it out.
 *
 * Reads whichever table the revision used: `WIRED_ROWS` before the re-cut,
 * `BEHAVIOURALLY_VERIFIED` and `LIVE_VERIFIED` after it. Both spellings appear
 * because the history spans the change, and a progression that silently stopped
 * counting at the rename would look like a flat line rather than a break.
 */
export function countLedgerRevision(revision: string): { promoted: number; live: number } | undefined {
	let source: string;
	try {
		source = git("show", `${revision}:${LEDGER}`);
	} catch {
		return undefined;
	}
	// The rows file is the authoritative promotion claim: a row's own status, not a
	// table beside it. Preferred everywhere it exists, because the table at HEAD
	// lagged it by one row — `terminal.showImages` was promoted onto the row and
	// never added to the table, so reading the table reported 248 against 249.
	const fromRows = promotedAt(revision);
	if (fromRows !== undefined) return { promoted: fromRows, live: liveAt(revision, source) };
	// The historical promotion table, for revisions predating the rows-file claim.
	const wired = source.match(/const WIRED_ROWS[\s\S]*?\n\};/)?.[0];
	if (!wired && !/const BEHAVIOURALLY_VERIFIED/.test(source)) return undefined;
	// Both quoted and unquoted keys, because both are valid object keys and a
	// quoted-only pattern undercounts.
	return {
		promoted: wired ? [...wired.matchAll(/^\t"?([A-Za-z_][A-Za-z0-9_.-]*)"?\s*:/gm)].length : 0,
		live: liveAt(revision, source),
	};
}

/**
 * Row ids the reference file marks `wired`, read from a revision.
 *
 * After the re-cut the promotion claim moved out of a table and onto the rows
 * themselves, so this reads the row status rather than a note.
 */
/** Rows marked `status: "wired"` at a revision, or undefined when unreadable. */
function promotedAt(revision: string): number | undefined {
	try {
		return promotedFromRows(git("show", `${revision}:packages/tui/src/overlays/settings-parity-rows.ts`));
	} catch {
		return undefined;
	}
}

/** The live-verified count at a revision, from the ledger table. */
function liveAt(revision: string, fallbackSource: string): number {
	const live = fallbackSource.match(/const LIVE_VERIFIED[\s\S]*?\]\);/)?.[0];
	return live ? [...live.matchAll(/"([^"]+)"/g)].length : 0;
}

/** Row ids marked `status: "wired"` in a rows-file source. */
function promotedFromRows(source: string): number {
	let current: string | undefined;
	let count = 0;
	for (const line of source.split("\n")) {
		const id = line.match(/^\t\tid: "([^"]+)",$/);
		if (id) {
			current = id[1];
			continue;
		}
		if (current !== undefined && /^\t\tstatus: "wired",$/.test(line)) count++;
	}
	return count;
}

/** The live-verified count at a revision, read from the ledger table. */
function source_live(revision: string): number {
	try {
		const source = git("show", `${revision}:packages/tui/src/overlays/settings-parity-ledger.ts`);
		const live = source.match(/const LIVE_VERIFIED[\s\S]*?\]\);/)?.[0];
		return live ? [...live.matchAll(/"([^"]+)"/g)].length : 0;
	} catch {
		return 0;
	}
}


/**
 * Phrases that mark a commit as explaining a change to the promotion count.
 *
 * Deliberately about *explaining a correction*, not about increments: the question is
 * whether a move was accounted for, not whether it went up.
 */
/**
 * Phrases that mark a commit as explaining a withdrawal of a promotion claim.
 *
 * Narrow deliberately. The first version included the bare word "ledger", which both
 * let a silent adjustment through ("refactor: tidy the ledger") and rejected a real
 * decrease (4ad43fc516, "a settings accessor read `this.settings.x`") - the word carries
 * no information about whether a claim was withdrawn. Every entry below appears in one of
 * the six real decreases in this repository's history, so the check is satisfiable by what
 * is actually there rather than by matching anything plausible.
 */
const WITHDRAWAL_PHRASES = [
	"the counts lied",
	"never reads it",
	"entirely unreachable",
	"never reached",
	"was not reachable",
	"no production read",
	"claimed `wired`",
	"no consumer",
	"unpromoted",
	"withdraw",
	"no longer wired",
	"never actually",
	"not actually wired",
	"row activation",
	"named a consumer that did not exist",
	"reported as having no production read",

];

export interface ProgressionStep {
	readonly hash: string;
	readonly subject: string;
	/**
	 * The full commit message. A withdrawal of a promotion claim is sometimes stated in the
	 * body rather than the subject - `1955cd2bcf` is titled "wire the provider protocol
	 * settings" but its body opens "Ten ledger rows claimed `wired` with no production
	 * read" - so attribution has to read both.
	 */
	readonly body: string;
	readonly promoted: number;
	readonly live: number;
}

/** Every point at which the promoted count changed, oldest first. */
export function promotionProgression(): ProgressionStep[] {
	const commits = git(
		"log",
		"--reverse",
		"--format=%H%x1f%s%x1f%b%x1e",
		"--",
		LEDGER,
		"packages/tui/src/overlays/settings-parity-rows.ts",
	)
		.split("\u001e")
		.map((record) => record.replace(/^\n+/, ""))
		.filter(Boolean)
		.map((record) => {
			const [hash = "", subject = "", ...body] = record.split("\u001f");
			return { hash, subject, body: body.join("\u001f").replace(/\n+$/, "") };
		});
	const steps: ProgressionStep[] = [];
	let previous: number | undefined;
	for (const commit of commits) {
		const counts = countLedgerRevision(commit.hash);
		if (!counts || counts.promoted === previous) continue;
		steps.push({ ...counts, hash: commit.hash.slice(0, 10), subject: commit.subject, body: commit.body });
		previous = counts.promoted;
	}
	// HEAD may have no ledger commit of its own — a working-tree change is not in
	// history — so its count is appended when it differs. Without this the last step
	// describes a past commit and silently disagrees with the ledger at HEAD.
	const head = countLedgerRevision("HEAD");
	if (head && head.promoted !== previous) {
		steps.push({ ...head, hash: "HEAD", subject: "working tree", body: "" });
	}
	return steps;
}

/**
 * Whether a step's commit says why the promotion count moved.
 *
 * The ledger is a **correctable** record. `a79f406b3` is titled "fix(ledger): the
 * evidence classes were mutually exclusive, so the counts lied" and corrected a count
 * downward; `90743ac3c0`, `df8270c833` and `d18f1bbc8f` each withdrew a claim the
 * reachability audit found unsupported. So a decrease is the audit working, not a
 * regression - and the property worth enforcing is not "the count never falls" but "a fall
 * is attributable to a commit that says so". That is strictly stronger against a silent
 * adjustment, which is the failure mode the original comment asked about.
 *
 * Both the subject and the body are read: `1955cd2bcf` is titled "wire the provider
 * protocol settings" and states the withdrawal only in its body ("Ten ledger rows claimed
 * `wired` with no production read").
 */
export function statesWhyPromotionChanged(step: ProgressionStep): boolean {
	const text = `${step.subject}\n${step.body}`.toLowerCase();
	return WITHDRAWAL_PHRASES.some((phrase) => text.includes(phrase));
}

/** The derived summary, for a report that must not guess. */
export function describeProgression(): string {
	const steps = promotionProgression();
	if (steps.length === 0) return "no ledger history";
	const first = steps[0]!;
	const last = steps.at(-1)!;
	return (
		`${first.promoted} → ${last.promoted} promoted across ${steps.length} ledger changes; ` +
		`${last.live} live verified at HEAD. Promoted is migration intent, not runtime reachability.`
	);
}
