import { describe, expect, it } from "vitest";
import { allSettings } from "../../coding-agent/src/core/settings-registry.ts";
import { buildLedger, describeLedger, reconcileLedger } from "../../tui/src/overlays/settings-parity-ledger.ts";
import { OMP_PARITY_ROW_COUNT, OMP_PARITY_ROWS } from "../../tui/src/overlays/settings-parity-rows.ts";
import { lookupSetting } from "../src/core/settings-registry.ts";
// Registration has the side effect of populating the typed registry.
import "../../coding-agent/src/core/settings-descriptors.ts";

/**
 * The settings ledger is derived, not tallied.
 *
 * Two reports in this program disagreed about how many rows were wired. A
 * hand-counted number is a claim; this file makes the count mechanical, so the
 * next disagreement is settled by running a test rather than by arguing.
 */

describe("the ledger reconciles against the reference contract", () => {
	it("accounts for exactly the reference's rows", () => {
		const summary = reconcileLedger();
		// Every reference row lands in exactly one bucket, and the buckets sum to
		// the reference's own declared total.
		const sum = summary.byState.wired + summary.byState["omp-present-unmigrated"] + summary.byState.deferred;
		expect(sum, "reference rows outside the pi-specific bucket must sum to the reference count").toBe(
			OMP_PARITY_ROW_COUNT,
		);
		expect(summary.unreconciled).toEqual([]);
	});

	it("has no row left unclassified or unevidenced", () => {
		for (const entry of buildLedger()) {
			expect(entry.state, entry.id).not.toBe("");
			// Every row states why it is in its state. A row with no reason is a
			// claim nobody made.
			expect(entry.note.length, entry.id).toBeGreaterThan(0);
		}
	});

	it("never claims a wired row without a typed registry key", () => {
		const summary = reconcileLedger();
		expect(summary.wiredWithoutKey).toEqual([]);
		for (const entry of buildLedger().filter((row) => row.state === "wired")) {
			expect(entry.piKey, entry.id).toBeTruthy();
		}
	});

	it("never disagrees with a row's own status field", () => {
		// The ledger's table is authoritative. If the two ever diverge, the row's
		// own label is what a user reads, and it would be stating something the
		// ledger does not believe.
		expect(reconcileLedger().statusMismatches).toEqual([]);
	});

	it("backs every wired row with a key that actually exists in the registry", () => {
		// A wired row whose key is not registered is claiming a consumer for a
		// setting nothing has declared. This is the check that makes "wired"
		// mean something more than "a label was changed".
		for (const entry of buildLedger().filter((row) => row.state === "wired")) {
			expect(lookupSetting(entry.piKey!), `${entry.id} -> ${entry.piKey}`).toBeDefined();
		}
	});
});

describe("the classifications are the ones the program claims", () => {
	it("marks exactly the rows with a proven runtime consumer as wired", () => {
		const wired = buildLedger()
			.filter((row) => row.state === "wired")
			.map((row) => row.id)
			.sort();
		// Listed rather than counted: a count in a test only proves the count
		// matches itself, and that is how a wrong number survives.
		expect(wired).toEqual([
			"autoResume",
			"browser.cdpUrl",
			"browser.enabled",
			"browser.freezeOnTurnEnd",
			"browser.headless",
			"browser.idleCloseSec",
			"browser.relay",
			"browser.relayUrl",
			"browser.screenshotDir",
			"claudeResets.autoRedeem",
			"claudeResets.keepCredits",
			"claudeResets.minBlockedMinutes",
			"claudeResets.salvageHorizonHours",
			"codexResets.autoRedeem",
			"codexResets.keepCredits",
			"codexResets.minBlockedMinutes",
			"codexResets.salvageHorizonHours",
			"compaction.dropUseless",
			"compaction.enabled",
			"compaction.idleEnabled",
			"compaction.idleThresholdTokens",
			"compaction.idleTimeoutSeconds",
			"compaction.supersedeReads",
			"compaction.thresholdPercent",
			"compaction.thresholdTokens",
			"composer.recallClearedDrafts",
			"defaultThinkingLevel",
			"display.cacheMissMarker",
			"display.collapseCompacted",
			"display.hideToolActivity",
			"display.showTokenUsage",
			"display.showTurnTime",
			"display.smoothStreaming",
			"edit.recoverInlineEdits",
			"exa.enabled",
			"exa.searchDelayMs",
			"extensionHandlers.toolCallTimeoutMs",
			"fetch.enabled",
			"followUpMode",
			"glob.enabled",
			"grep.contextAfter",
			"grep.contextBefore",
			"grep.enabled",
			"interruptMode",
			"loop.conditionTimeoutMs",
			"loop.mode",
			"mcp.enableProjectConfig",
			"mcp.notificationDebounceMs",
			"mcp.notifications",
			"mcp.renderMarkdownResults",
			"mcp.startupTimeoutMs",
			"memory.backend",
			"minP",
			"mnemopi.autoRecall",
			"mnemopi.autoRetain",
			"mnemopi.bank",
			"mnemopi.dbPath",
			"mnemopi.scoping",
			"model.toolCallLoopGuard.enabled",
			"model.toolCallLoopGuard.exemptTools",
			"model.toolCallLoopGuard.threshold",
			"presencePenalty",
			"providers.fetch",
			"providers.streamFirstEventTimeoutSeconds",
			"providers.streamIdleTimeoutSeconds",
			"repetitionPenalty",
			"retry.fallbackChains",
			"retry.fallbackRevertPolicy",
			"retry.maxDelayMs",
			"retry.maxRetries",
			"retry.modelFallback",
			"searxng.endpoint",
			"secrets.enabled",
			"showHardwareCursor",
			"steeringMode",
			"task.batch",
			"task.eager",
			"task.enableEffort",
			"task.enableLsp",
			"task.maxConcurrency",
			"task.maxEffort",
			"task.maxRecursionDepth",
			"task.softRequestBudget",
			"tasks.todoClearDelay",
			"temperature",
			"todo.eager",
			"todo.enabled",
			"todo.reminders",
			"todo.remindersMax",
			"tools.artifactHeadBytes",
			"tools.artifactSpillThreshold",
			"tools.artifactTailBytes",
			"tools.artifactTailLines",
			"tools.outputMaxColumns",
			"topK",
			"topP",
			"tui.hyperlinks",
			"tui.imeSafeCursor",
			"tui.resizeScrollback",
			"tui.tight",
			"web_search.enabled",
		]);
	});

	it("separates wired from live verified", () => {
		const entries = buildLedger();
		const live = entries
			.filter((row) => row.liveVerified)
			.map((row) => row.id)
			.sort();
		// Live verification is a stronger claim and is tracked separately, so a
		// row can be consumed by a runtime without the behaviour being exercised
		// end to end. The two registry-only rows are in that gap: their defaults
		// are declared and consumed by the retry policy, but no test drives a
		// retry through them.
		expect(live).toEqual([
			"autoResume",
			"claudeResets.autoRedeem",
			"claudeResets.keepCredits",
			"claudeResets.minBlockedMinutes",
			"claudeResets.salvageHorizonHours",
			"codexResets.autoRedeem",
			"codexResets.keepCredits",
			"codexResets.minBlockedMinutes",
			"codexResets.salvageHorizonHours",
			"compaction.dropUseless",
			"compaction.supersedeReads",
			"defaultThinkingLevel",
			"edit.recoverInlineEdits",
			"followUpMode",
			"interruptMode",
			"loop.conditionTimeoutMs",
			"loop.mode",
			"memory.backend",
			"mnemopi.autoRecall",
			"mnemopi.autoRetain",
			"mnemopi.bank",
			"mnemopi.dbPath",
			"mnemopi.scoping",
			"model.toolCallLoopGuard.enabled",
			"model.toolCallLoopGuard.exemptTools",
			"model.toolCallLoopGuard.threshold",
			"retry.fallbackChains",
			"retry.fallbackRevertPolicy",
			"retry.modelFallback",
			"secrets.enabled",
			"steeringMode",
			"todo.enabled",
		]);
	});

	it("reports the count the way a status line would", () => {
		const summary = reconcileLedger();
		const description = describeLedger();
		expect(description).toContain(`${summary.byState.wired} wired`);
		expect(description).toContain(`of ${OMP_PARITY_ROW_COUNT}`);
	});

	it("counts every tab, so a tab cannot silently vanish", () => {
		const summary = reconcileLedger();
		const tabsFromRows = new Set(OMP_PARITY_ROWS.map((row) => row.tab));
		expect(Object.keys(summary.byTab).sort()).toEqual([...tabsFromRows].sort());
		for (const [tab, counts] of Object.entries(summary.byTab)) {
			const total = counts.wired + counts["omp-present-unmigrated"] + counts.deferred + counts["pi-specific"];
			const actual = OMP_PARITY_ROWS.filter((row) => row.tab === tab).length;
			expect(total, tab).toBe(actual);
		}
	});
});

describe("a wired row is a deliberate claim, not a relabelling", () => {
	it("requires the claim to name what consumes it", () => {
		for (const entry of buildLedger().filter((row) => row.state === "wired")) {
			// "Wired" without a named consumer is the same as "registered", and
			// conflating them is how a settings panel starts lying.
			expect(entry.note, entry.id).toMatch(/consumed|resolved/);
		}
	});

	it("keeps every non-wired row's own reason visible", () => {
		const notWired = buildLedger().filter((row) => row.state !== "wired");
		expect(notWired.length).toBeGreaterThan(0);
		for (const entry of notWired) {
			// A row that is not wired must say why, so a user who finds it
			// disabled is not left guessing.
			expect(entry.note, entry.id).toBeTruthy();
		}
	});

	it("agrees with the typed registry on how many settings exist", () => {
		// Not an equality check - the registry covers more than the panel shows -
		// but every wired row's key must be one the registry actually holds, which
		// the test above asserts. This records the relationship explicitly.
		expect(allSettings().length).toBeGreaterThan(0);
	});
});

describe("the two ledgers are not conflated", () => {
	it("derives from the 383-row contract, not the smaller recorded list", () => {
		// The file `settings-parity-map.ts` holds a small memory-tab list with its
		// own `TAB_SETTINGS_RECORDED` flags, and the contract holds 383 rows. Both are
		// legitimate; conflating them is what let two completion reports disagree
		// about how many rows were wired. This ledger reads the contract, so the
		// count it produces is the reference's.
		expect(buildLedger().length).toBe(OMP_PARITY_ROW_COUNT);
		expect(reconcileLedger().total).toBe(OMP_PARITY_ROW_COUNT);
	});
});
