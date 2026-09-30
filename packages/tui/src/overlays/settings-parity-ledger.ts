/**
 * The mechanical settings ledger.
 *
 * ## Why this exists
 *
 * A completion count that a person tallied by hand is a claim, not evidence. Two
 * reports in this program disagreed about how many rows were wired, and the only
 * way to settle it was to parse the contract.
 *
 * ## Why the states were re-cut in September 2026
 *
 * The original model had one state, `wired`, meaning "listed in a table with a
 * note explaining which consumer should read it". A reachability audit then found
 * **223 of 249** rows so classified had a registered settings key that no source
 * file referenced: every one of them registered-but-unread. The note is a claim
 * about intent, and it was being read as proof of integration.
 *
 * So the states are now evidence classes, each mechanically checkable, and
 * `wired` is retired as a completion claim. It survives only as
 * {@link EvidenceClass.promoted} — historical migration intent, retained for
 * audit history and never counted as integration.
 *
 * The chain each row must walk:
 *
 *     reference row → registry key → production path obtains it → behaviour
 *
 * and a row may only claim the last two with evidence: a proven production
 * consumption site for reachability, a test that changes the setting and observes
 * a difference for behaviour.
 *
 * ## What is deliberately not here
 *
 * No state is derived from a search for a key string. The reachability analysis
 * in `scripts/lib/reachability.ts` resolves typed accessors, injected readers and
 * nested settings paths, and anything it cannot settle is reported as
 * `needs-review` rather than counted either way. A false negative costs a human
 * read; a false positive would declare an inert setting integrated, which is the
 * exact failure this re-cut exists to remove.
 */

import { OMP_PARITY_ROW_COUNT, OMP_PARITY_ROWS, type ParityRow } from "./settings-parity-rows.ts";

/**
 * How far a row is proven, weakest first.
 *
 * These are ordered by what each one *asserts*, not by how hard they are to
 * reach. `registered` is a fact about the registry; `runtime-reachable` is a fact
 * about a production call graph; `behaviourally-verified` is a fact about an
 * observed difference.
 */
export const EVIDENCE_CLASSES = [
	/** Not present in PrimePi's typed registry. */
	"unregistered",
	/** The reference setting exists in PrimePi's typed registry. */
	"registered",
	/** Capability code exists that governs this setting. */
	"implemented",
	/** A production path obtains the value and it can influence behaviour. */
	"runtime-reachable",
	/** A test changes the setting and observes a behavioural difference. */
	"behaviourally-verified",
	/** Exercised through the live or installed runtime path. */
	"live-verified",
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * How a row got here, which is orthogonal to how far it is proven.
 *
 * `omp-present-unmigrated` and `deferred` describe the reference's own status;
 * `pi-specific` marks a PrimePi-only row that sits outside the 383.
 */
export type LedgerState = "omp-present-unmigrated" | "deferred" | "pi-specific";

/** A row's classification, with the evidence for it. */
export interface LedgerEntry {
	readonly id: string;
	readonly tab: string;
	readonly state: LedgerState;
	/**
	 * The typed registry key.
	 *
	 * Present whenever the row is registered; its absence is the `unregistered`
	 * evidence class rather than an omission.
	 */
	readonly piKey?: string;
	/**
	 * How far this row is proven. Separate from `state`, because a row can be
	 * `deferred` by the reference and still `registered` by PrimePi.
	 */
	readonly evidence: EvidenceClass;
	/**
	 * Every class this row asserts, weakest first.
	 *
	 * Cumulative by construction, so a report can count the sets as nested without
	 * the ledger and the invariants disagreeing about what the numbers mean.
	 */
	readonly claims: readonly EvidenceClass[];
	/**
	 * Production sites proven to obtain the key.
	 *
	 * Empty does not by itself mean inert — a parameterized accessor is
	 * unresolvable statically and is reported separately — but a row claiming
	 * `runtime-reachable` with no site is a contradiction the test rejects.
	 */
	readonly consumedBy?: readonly { readonly site: string; readonly via: string }[];
	/** Why the row is in this state, in words. */
	readonly note: string;
	/**
	 * The historical promotion claim.
	 *
	 * Retained because migration history is worth keeping, and explicitly *not* a
	 * completion signal: on 2026-09-30 this flag described 249 rows of which 223
	 * had no consumer at all.
	 */
	readonly promoted?: string;
}

/** Rows proven behaviourally: a test changes the setting and observes a difference. */
const BEHAVIOURALLY_VERIFIED = new Set<string>([
	// Each of these has a test that sets the key and asserts a different runtime
	// outcome through the production path, not through a helper.
	"model.toolCallLoopGuard.enabled",
	"model.toolCallLoopGuard.threshold",
	"model.toolCallLoopGuard.exemptTools",
	"tools.artifactSpillThreshold",
	"tools.artifactHeadBytes",
	"tools.artifactTailLines",
	"tools.outputMaxColumns",
	"read.summarize.enabled",
	"edit.blockAutoGenerated",
	"task.isolation.enabled",
	"task.isolation.apply",
	"task.isolation.merge",
	"compaction.thresholdPercent",
	"compaction.thresholdTokens",
	"tui.titleState",
	"tui.titleSpinner",
	"providers.maxInFlightRequests",
	"retry.fallbackChains",
	"secrets.enabled",
	"memory.backend",
	"todo.enabled",
	// Both proven in test/image-settings-wiring.test.ts: each is written to a
	// real settings.json, parsed by the registry, and observed on the messages
	// the provider is handed — not on a tool's return value.
	"images.autoResize",
	"images.blockImages",
]);

/**
 * Rows proven live: exercised through the running or installed build.
 *
 * Strictly narrower than behavioural verification, and never a substitute for
 * it. A capability whose provider or native dependency is unavailable locally is
 * recorded as verification debt instead of appearing here.
 */
const LIVE_VERIFIED = new Set<string>([
	"memory.backend",
	"mnemopi.dbPath",
	"mnemopi.bank",
	"mnemopi.scoping",
	"mnemopi.autoRecall",
	"mnemopi.autoRetain",
	"retry.modelFallback",
	"retry.fallbackChains",
	"retry.fallbackRevertPolicy",
	"todo.enabled",
	"secrets.enabled",
	"edit.recoverInlineEdits",
	"compaction.dropUseless",
	"compaction.supersedeReads",
	"autoResume",
	"defaultThinkingLevel",
	"followUpMode",
	"interruptMode",
	"steeringMode",
	"loop.mode",
	"codexResets.autoRedeem",
	"claudeResets.autoRedeem",
]);

/**
 * Registry keys proven obtained by a production path.
 *
 * Populated from the reachability analysis rather than written by hand, because a
 * hand-written list is the same class of claim this module was re-cut to remove.
 * Injected by the audit; absent in unit tests, where the class degrades to
 * `registered` rather than asserting reachability it cannot prove.
 */
let consumptionIndex: ReadonlyMap<string, readonly { site: string; via: string }[]> = new Map();

/**
 * Installs the measured consumption index.
 *
 * Called by the audit script, which has the repository to read. Absent it, every
 * row reports `registered` — the conservative floor — and the tests still hold,
 * because they assert structural invariants rather than counts.
 */
export function setConsumptionIndex(index: ReadonlyMap<string, readonly { site: string; via: string }[]>): void {
	consumptionIndex = index;
}

/** The measured consumption index, for a status line or a report. */
export function getConsumptionIndex(): ReadonlyMap<string, readonly { site: string; via: string }[]> {
	return consumptionIndex;
}

function stateFor(row: ParityRow): LedgerState {
	if (row.status === "pi-specific") return "pi-specific";
	if (row.status === "omp-present-unmigrated") return "omp-present-unmigrated";
	return "deferred";
}

/** Classifies every row, with the evidence for it. */
export function buildLedger(): readonly LedgerEntry[] {
	return OMP_PARITY_ROWS.map((row) => {
		const state = stateFor(row);
		const promoted = row.status === "wired" ? (row.note ?? "promoted") : undefined;
		// A row with no `piKey` declares nothing in PrimePi. Falling back to
		// `row.id` would assert a registration that does not exist — which is the
		// mistake this module was re-cut to remove.
		const key = row.piKey;
		const sites = key === undefined ? undefined : consumptionIndex.get(key);
		// Cumulative claims, weakest first. Each is independent and each implies every
		// weaker one, so the subset invariants hold by construction rather than by
		// convention:
		//
		//     live-verified ⊆ behaviourally-verified ⊆ runtime-reachable ⊆ registered
		//
		// The previous single-value ladder made these *mutually exclusive*, so a row
		// claiming behavioural evidence was not counted as reachable. A report quoting
		// "16 reachable, 17 behavioural" against an enforced subset invariant was
		// therefore describing two universes without saying so.
		const reachable = sites !== undefined && sites.length > 0;
		const behavioural = reachable && BEHAVIOURALLY_VERIFIED.has(row.id);
		const liveVerified = behavioural && LIVE_VERIFIED.has(row.id);
		const claims = new Set<EvidenceClass>();
		if (key === undefined) claims.add("unregistered");
		else claims.add("registered");
		if (reachable) claims.add("runtime-reachable");
		if (behavioural) claims.add("behaviourally-verified");
		if (liveVerified) claims.add("live-verified");
		// The strongest claim asserted, kept for the row display.
		const evidence = liveVerified
			? "live-verified"
			: behavioural
				? "behaviourally-verified"
				: reachable
					? "runtime-reachable"
					: key === undefined
						? "unregistered"
						: "registered";
		return {
			id: row.id,
			tab: row.tab,
			state,
			claims: [...claims],
			...(row.piKey ? { piKey: row.piKey } : {}),
			evidence,
			...(sites !== undefined && sites.length > 0 ? { consumedBy: [...sites] } : {}),
			// The historical note is retained as the promotion claim, and the row's
			// own text becomes the note. Neither is an evidence claim.
			note: row.note ?? `not migrated: the ${row.id} subsystem is not in PrimePi`,
			...(promoted ? { promoted } : {}),
		};
	});
}

export interface LedgerSummary {
	readonly total: number;
	readonly byEvidence: Readonly<Record<EvidenceClass, number>>;
	readonly byState: Readonly<Record<LedgerState, number>>;
	readonly byTab: Readonly<Record<string, Readonly<Record<LedgerState, number>>>>;
	/** Rows whose classification did not reconcile. Must be empty. */
	readonly unreconciled: readonly string[];
	/** Rows claiming a registry key the typed registry does not have. Must be empty. */
	readonly registeredWithoutKey: readonly string[];
	/** Rows claiming to be live-verified without being behaviourally verified. Must be empty. */
	readonly liveWithoutBehaviour: readonly string[];
	/** Rows claiming runtime reachability with no proven consumption site. Must be empty. */
	readonly reachableWithoutSite: readonly string[];
	/**
	 * Rows claiming live verification with no proven consumption site. Must be empty.
	 *
	 * Live verification is the strongest claim in the model and the easiest to make
	 * by hand: a row listed in `LIVE_VERIFIED` reads as proven even when nothing
	 * reads the setting. This check is what keeps that claim honest, and it is the
	 * check the pre-September model lacked entirely.
	 */
	readonly liveWithoutSite: readonly string[];
}

function emptyEvidence(): Record<EvidenceClass, number> {
	return {
		unregistered: 0,
		registered: 0,
		implemented: 0,
		"runtime-reachable": 0,
		"behaviourally-verified": 0,
		"live-verified": 0,
	};
}

function emptyState(): Record<LedgerState, number> {
	return { "omp-present-unmigrated": 0, deferred: 0, "pi-specific": 0 };
}

/**
 * Reconciles the ledger.
 *
 * Every failure returned here is a claim the panel cannot back, so a caller that
 * ignores them is asserting something untrue. The test uses all of them.
 */
export function reconcileLedger(): LedgerSummary {
	const entries = buildLedger();
	const byEvidence = emptyEvidence();
	const byState = emptyState();
	const byTab: Record<string, Record<LedgerState, number>> = {};
	const unreconciled: string[] = [];
	const registeredWithoutKey: string[] = [];
	const liveWithoutBehaviour: string[] = [];
	const reachableWithoutSite: string[] = [];
	const liveWithoutSite: string[] = [];

	// Nested sets, not exclusive buckets: a row asserting `behaviourally-verified` also
	// asserts `runtime-reachable` and `registered`. Counting each class once per
	// asserted claim is what makes the subset invariants meaningful.
	for (const entry of entries) {
		for (const claimed of entry.claims) byEvidence[claimed] += 1;
		byState[entry.state] += 1;
		byTab[entry.tab] ??= emptyState();
		byTab[entry.tab]![entry.state] += 1;
		if (!entry.note) unreconciled.push(entry.id);
		// A row claiming a registry key must have one. This is the assertion that
		// survives the re-cut: it is a fact about the registry, not a claim about
		// intent.
		if (entry.piKey === undefined && entry.evidence !== "unregistered") {
			registeredWithoutKey.push(entry.id);
		}
		// The invariant the old model got wrong: live verification is strictly
		// stronger than behavioural, so a row cannot be live without being tested.
		if (entry.evidence === "live-verified" && !BEHAVIOURALLY_VERIFIED.has(entry.id)) {
			liveWithoutBehaviour.push(entry.id);
		}
		// A row claiming reachability must show where. Without this the class is a
		// label.
		if (entry.evidence !== "unregistered" && entry.evidence !== "registered") {
			if ((entry.consumedBy?.length ?? 0) === 0) reachableWithoutSite.push(entry.id);
		}
		// A live claim with no proven production read is the strongest false claim
		// available: it asserts the behaviour was exercised through a real runtime path
		// that the analysis cannot find. Reported rather than assumed away.
		if (entry.evidence === "live-verified" && (entry.consumedBy?.length ?? 0) === 0) {
			liveWithoutSite.push(entry.id);
		}
	}

	const referenceRows = entries.filter((entry) => entry.state !== "pi-specific");
	if (referenceRows.length !== OMP_PARITY_ROW_COUNT) {
		unreconciled.push(`row count: ${referenceRows.length} reference rows, expected ${OMP_PARITY_ROW_COUNT}`);
	}

	return {
		total: entries.length,
		byEvidence,
		byState,
		byTab,
		unreconciled,
		registeredWithoutKey,
		liveWithoutBehaviour,
		reachableWithoutSite,
		liveWithoutSite,
	};
}

/**
 * A one-line report.
 *
 * Reports the evidence classes rather than a single wired count, because the
 * single count is what this module was re-cut to stop leading with.
 */
export function describeLedger(): string {
	const summary = reconcileLedger();
	const parts = [
		`${summary.byEvidence["live-verified"]} live`,
		`${summary.byEvidence["behaviourally-verified"]} behavioural`,
		`${summary.byEvidence["runtime-reachable"]} reachable`,
		`${summary.byEvidence.registered} registered`,
		`${summary.byEvidence.unregistered} unregistered`,
	];
	const promoted = buildLedger().filter((entry) => entry.promoted !== undefined).length;
	return `${parts.join(", ")} of ${summary.total} reference rows (${promoted} historically promoted)`;
}
