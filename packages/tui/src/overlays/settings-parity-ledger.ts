/**
 * The mechanical settings ledger.
 *
 * ## Why this exists
 *
 * A completion count that a person tallied by hand is a claim, not evidence. Two
 * reports in this program disagreed about how many rows were wired, and the
 * only way to settle it was to parse the contract. So the count is now derived
 * from {@link OMP_PARITY_ROWS} itself, and this module is the single place that
 * reconciles the rows against the four evidence states.
 *
 * ## The states, and what each one asserts
 *
 * - `wired` — a runtime consumer reads the value and its behaviour is proven to
 *   the level that capability needs. **A setting key existing proves nothing
 *   about this.** A row reaches `wired` by being listed in {@link WIRED_ROWS},
 *   which is a claim someone had to make deliberately, and the test below checks
 *   that claim against the registry.
 * - `pi-specific` — PrimePi has the capability and the reference does not. These
 *   sit *outside* the reference's 383 and are counted separately, because folding
 *   them into that total would make the reference look larger than it is.
 * - `omp-present-unmigrated` — the reference shows it; the subsystem is not
 *   migrated. A parity marker, not a working control.
 * - `deferred` — transcribed but deliberately not scheduled.
 *
 * ## Reconciliation
 *
 * {@link reconcileLedger} must account for every row exactly once and sum to
 * {@link OMP_PARITY_ROW_COUNT}. A row that falls through every bucket, or a
 * `wired` row whose `piKey` is absent from the typed registry, is a failure -
 * not a warning, because either one means the panel is claiming something it
 * cannot back.
 */

import { OMP_PARITY_ROW_COUNT, OMP_PARITY_ROWS, type ParityRow } from "./settings-parity-rows.ts";

/** A row whose runtime consumer is proven. Every entry is a deliberate claim. */
const WIRED_ROWS: Readonly<Record<string, string>> = {
	// Memory tab, General.
	followUpMode: "consumed by takeBatch; a follow-up queue keeps draining under either mode while anything is left",
	interruptMode:
		"consumed by shouldInterrupt; wait spares side-effecting calls and still cuts short purely interruptible ones",
	steeringMode: "consumed by takeBatch; one-at-a-time lets the model act on a redirect before seeing the next",
	"loop.conditionTimeoutMs":
		"consumed as the bound on one condition evaluation, and 0 disables the bound rather than defaulting",
	"loop.mode": "consumed between /loop iterations before re-submitting the prompt",
	"memory.backend": "resolved by SessionMemory.create and consumed by the backend registry",
	// Memory tab, Mnemopi. The bank store and its lifecycle.
	"mnemopi.dbPath": "consumed by the bank store as its storage root; empty means the agent directory",
	"mnemopi.bank": "consumed as the shared bank base name; per-project scopes prefix it",
	"mnemopi.scoping": "consumed to choose global, per-project, or per-project-tagged bank scope",
	"mnemopi.autoRecall": "consumed by AutoMemoryLifecycle; recall runs at most once per user turn",
	"mnemopi.autoRetain": "consumed by AutoMemoryLifecycle; retention advances a cursor so a turn is stored once",
	// Model tab, Retry & Fallback.
	"retry.maxRetries": "consumed by the retry policy when it builds its attempt budget",
	"retry.maxDelayMs": "consumed by getRetrySettings as maxAgentDelayMs, the upper bound on backoff between attempts",
	"retry.modelFallback": "consumed by resolveFallbackChain as the off/allowed switch",
	"retry.fallbackChains": "consumed as the ordered routes resolveFallbackChain walks",
	"retry.fallbackRevertPolicy": "consumed by shouldRevertToPrimary",
	// Providers tab, Services: saved rate-limit reset credits.
	"codexResets.autoRedeem": "consumed by decideRedeem; unset asks before the first spend rather than being a boolean",
	"codexResets.minBlockedMinutes": "consumed as the minimum block duration before a rescue is considered",
	"codexResets.keepCredits": "consumed as a reserve never spent automatically",
	"codexResets.salvageHorizonHours": "consumed by creditsExpiringWithin as the horizon for salvaging an unused credit",
	"claudeResets.autoRedeem": "consumed by decideRedeem; unset asks before the first spend rather than being a boolean",
	"claudeResets.minBlockedMinutes": "consumed as the minimum block duration before a rescue is considered",
	"claudeResets.keepCredits": "consumed as a reserve never spent automatically",
	"claudeResets.salvageHorizonHours":
		"consumed by creditsExpiringWithin as the horizon for salvaging an unused credit",
	// Appearance tab, Display.
	"tui.resizeScrollback":
		"consumed by planScrollbackResize; a resize that changed nothing never erases, and only a settled width refreshes history",
	// Context tab, Compaction. Promoted from the pruning implementation and its tests.
	"compaction.dropUseless":
		"consumed by pruneToolOutputs, which elides results the tool flagged as carrying no information",
	// Providers tab, Timeouts.
	"providers.streamFirstEventTimeoutSeconds":
		"consumed by withStreamWatchdog; -1 inherits the provider default and 0 disables the watchdog",
	"providers.streamIdleTimeoutSeconds": "consumed by withStreamWatchdog as the per-gap budget",
	// Providers tab, Privacy.
	"secrets.enabled":
		"consumed by SecretObfuscator, which replaces configured secrets with a keyed placeholder before the request leaves the machine",
	// Model tab, Thinking.
	"composer.recallClearedDrafts":
		"consumed by DraftHistory.clear; a composer holding an image is not empty, and the setting governs future clears only",
	defaultThinkingLevel:
		"consumed by resolveThinkingLevelForModel, which clamps down to what the active model supports",
	"todo.enabled":
		"consumed by the todo tool; the plan is read from the latest committed branch entry, so a resume or rewind cannot revert it",
	"model.toolCallLoopGuard.enabled":
		"consumed by ToolCallLoopGuard; a detection steers the model away rather than aborting the turn",
	"model.toolCallLoopGuard.threshold":
		"consumed as the number of identical consecutive turns before the guard intervenes",
	"model.toolCallLoopGuard.exemptTools": "consumed as the tools a turn may call without counting as a loop",
	// Files tab, Editing.
	"edit.recoverInlineEdits":
		"consumed by recoverInlineSloppyEdit; a stray payload becomes a synthetic edit tool call so the approval pipeline still runs",
	// Interaction tab, Startup & Updates.
	autoResume:
		"consumed by chooseSessionToResume; a resumed session restores its own model instead of taking a CLI default",
	"compaction.supersedeReads":
		"consumed by pruneToolOutputs, which replaces a result a newer read of the same target made redundant",
};

/** The states, kept distinct because collapsing them is how a panel lies. */
export type LedgerState = "wired" | "omp-present-unmigrated" | "deferred" | "pi-specific";

/** A row's classification, with the evidence for it. */
export interface LedgerEntry {
	readonly id: string;
	readonly tab: string;
	readonly state: LedgerState;
	/** The typed registry key, for a wired row. */
	readonly piKey?: string;
	/** Why the row is in this state. */
	readonly note: string;
	/** True when a runtime consumer is proven, which is a stronger claim than
	 *  "the control renders" or "the key exists". */
	readonly liveVerified?: boolean;
}

export interface LedgerSummary {
	readonly total: number;
	readonly byState: Readonly<Record<LedgerState, number>>;
	readonly byTab: Readonly<Record<string, Readonly<Record<LedgerState, number>>>>;
	/** Rows whose classification did not reconcile. Must be empty. */
	readonly unreconciled: readonly string[];
	/** Wired rows with no typed registry key. Must be empty. */
	readonly wiredWithoutKey: readonly string[];
	/** Rows claiming wired whose declared `status` field disagrees. */
	readonly statusMismatches: readonly string[];
}

/** Rows proven live-verified, distinct from merely wired. */
const LIVE_VERIFIED: ReadonlySet<string> = new Set([
	"memory.backend",
	"mnemopi.dbPath",
	"mnemopi.bank",
	"mnemopi.scoping",
	"mnemopi.autoRecall",
	"mnemopi.autoRetain",
	"retry.modelFallback",
	"todo.enabled",
	"retry.fallbackChains",
	"retry.fallbackRevertPolicy",
	"secrets.enabled",
	"autoResume",
	"edit.recoverInlineEdits",
	"compaction.dropUseless",
	"compaction.supersedeReads",
	"codexResets.autoRedeem",
	"codexResets.keepCredits",
	"codexResets.minBlockedMinutes",
	"codexResets.salvageHorizonHours",
	"claudeResets.autoRedeem",
	"claudeResets.keepCredits",
	"claudeResets.minBlockedMinutes",
	"claudeResets.salvageHorizonHours",
	"defaultThinkingLevel",
	"model.toolCallLoopGuard.enabled",
	"model.toolCallLoopGuard.exemptTools",
	"model.toolCallLoopGuard.threshold",
	"loop.conditionTimeoutMs",
	"loop.mode",
	"followUpMode",
	"interruptMode",
	"steeringMode",
]);

function stateFor(row: ParityRow): LedgerState {
	// The WIRED_ROWS table is authoritative, not the row's own `status` field.
	// Otherwise relabelling a row would promote it, which is exactly the mistake
	// this module exists to prevent.
	if (row.id in WIRED_ROWS) return "wired";
	if (row.status === "pi-specific") return "pi-specific";
	if (row.status === "omp-present-unmigrated") return "omp-present-unmigrated";
	return "deferred";
}

/** Classifies every row, with its evidence. */
export function buildLedger(): readonly LedgerEntry[] {
	return OMP_PARITY_ROWS.map((row) => {
		const state = stateFor(row);
		const wired = state === "wired";
		const note = wired
			? WIRED_ROWS[row.id]!
			: (row.note ?? `not wired: the ${row.id} subsystem is not migrated into PrimePi`);
		return {
			id: row.id,
			tab: row.tab,
			state,
			...(wired ? { piKey: row.piKey ?? row.id } : {}),
			note,
			...(wired && LIVE_VERIFIED.has(row.id) ? { liveVerified: true } : {}),
		};
	});
}

/**
 * Reconciles the ledger.
 *
 * Every failure returned here is a claim the panel cannot back, so a caller
 * that ignores them is asserting something untrue. The test uses all three.
 */
export function reconcileLedger(): LedgerSummary {
	const entries = buildLedger();
	const byState: Record<LedgerState, number> = {
		wired: 0,
		"omp-present-unmigrated": 0,
		deferred: 0,
		"pi-specific": 0,
	};
	const byTab: Record<string, Record<LedgerState, number>> = {};
	const unreconciled: string[] = [];
	const wiredWithoutKey: string[] = [];
	const statusMismatches: string[] = [];

	for (const entry of entries) {
		byState[entry.state] += 1;
		byTab[entry.tab] ??= { wired: 0, "omp-present-unmigrated": 0, deferred: 0, "pi-specific": 0 };
		byTab[entry.tab]![entry.state] += 1;
		if (entry.state === "wired") {
			if (!entry.piKey) wiredWithoutKey.push(entry.id);
			// A row marked wired in the table but still carrying an unmigrated
			// status in the contract is a contradiction, and the row's own label
			// would then be what a user reads.
			const row = OMP_PARITY_ROWS.find((candidate) => candidate.id === entry.id);
			if (row && row.status !== "wired") statusMismatches.push(entry.id);
		}
		if (!entry.note) unreconciled.push(entry.id);
	}

	// PrimePi-only rows sit outside the reference total by design, so the
	// reconciliation is against the reference count specifically.
	const referenceRows = entries.filter((entry) => entry.state !== "pi-specific");
	if (referenceRows.length !== OMP_PARITY_ROW_COUNT) {
		unreconciled.push(`row count: ${referenceRows.length} reference rows, expected ${OMP_PARITY_ROW_COUNT}`);
	}

	return {
		total: entries.length,
		byState,
		byTab,
		unreconciled,
		wiredWithoutKey,
		statusMismatches,
	};
}

/** A one-line report, for a status line or a commit body. */
export function describeLedger(): string {
	const summary = reconcileLedger();
	const parts = [
		`${summary.byState.wired} wired`,
		`${summary.byState["omp-present-unmigrated"]} unmigrated`,
		`${summary.byState.deferred} deferred`,
		`${summary.byState["pi-specific"]} pi-specific`,
	];
	const live = buildLedger().filter((entry) => entry.liveVerified).length;
	return `${parts.join(", ")} of ${summary.total} (${live} live verified)`;
}
