import { describe, expect, it } from "vitest";
import {
	DiagnosticsLedger,
	describeFreshness,
	diagnosticsSnapshot,
	shouldRefreshAfterWrite,
} from "../src/core/lsp/integration.ts";
import type { LspDiagnostic, ResolvedDiagnostic } from "../src/core/lsp/operations.ts";

/**
 * LSP diagnostics integration.
 *
 * The property that carries this module is **an empty set is never reported as
 * "no problems"**. Three of the four freshness values say something about the
 * *tooling*, not about the code, and collapsing them into "no diagnostics"
 * teaches the model a file is clean when the truth is that nothing has looked at
 * it yet.
 */

const diagnostic = (line: number, message: string): LspDiagnostic => ({
	range: { start: { line, character: 0 }, end: { line, character: 5 } },
	message,
	severity: 1,
});

/** A resolver that keeps the fields this test cares about. */
const resolve = (uri: string, entries: readonly LspDiagnostic[]): readonly ResolvedDiagnostic[] =>
	entries.map((entry) => ({
		uri,
		displayPath: uri.replace("file://", ""),
		range: entry.range,
		message: entry.message,
		severity: "error" as const,
		line: entry.range.start.line + 1,
		column: entry.range.start.character + 1,
	}));

const claimed = { claimed: true, usable: true };

describe("the ledger keeps the newest publication", () => {
	it("replaces rather than appends for the same file", () => {
		// A file edited twice publishes twice. Showing both puts the same error at two
		// line positions with the model free to act on the stale one.
		const ledger = new DiagnosticsLedger();
		ledger.publish("file:///a.ts", [diagnostic(0, "first")]);
		ledger.publish("file:///a.ts", [diagnostic(9, "second")]);
		expect(ledger.get("file:///a.ts")).toHaveLength(1);
		expect(ledger.get("file:///a.ts")?.[0]?.message).toBe("second");
	});

	it("bounds itself", () => {
		const ledger = new DiagnosticsLedger(2);
		for (let index = 0; index < 5; index++) ledger.publish(`file:///${index}.ts`, [diagnostic(0, "x")]);
		expect(ledger.size).toBe(2);
	});

	it("evicts the oldest, not the newest", () => {
		// The oldest publication is the one least likely to still describe the file.
		const ledger = new DiagnosticsLedger(2);
		ledger.publish("file:///old.ts", [diagnostic(0, "old")]);
		ledger.publish("file:///mid.ts", [diagnostic(0, "mid")]);
		ledger.publish("file:///new.ts", [diagnostic(0, "new")]);
		expect(ledger.get("file:///old.ts")).toBeUndefined();
		expect(ledger.get("file:///new.ts")).toHaveLength(1);
	});

	it("drops a publication for a file the model just changed", () => {
		// The server will republish; until it does, the file is pending rather than
		// carrying diagnostics computed against content that no longer exists.
		const ledger = new DiagnosticsLedger();
		ledger.publish("file:///a.ts", [diagnostic(0, "stale")]);
		ledger.drop("file:///a.ts");
		expect(ledger.get("file:///a.ts")).toBeUndefined();
	});
});

describe("an empty set is never reported as no problems", () => {
	it("says pending when nothing has published yet", () => {
		// The distinction is the whole point of deferring. "No diagnostics" here is a
		// claim about the code that nothing has checked.
		const ledger = new DiagnosticsLedger();
		const snapshot = diagnosticsSnapshot({ ledger, uri: "file:///a.ts", server: claimed, resolve });
		expect(snapshot.freshness).toBe("pending");
		expect(snapshot.diagnostics).toEqual([]);
		expect(describeFreshness("pending")).toMatch(/has not reported/);
	});

	it("says no-server when nothing claims the file", () => {
		const ledger = new DiagnosticsLedger();
		const snapshot = diagnosticsSnapshot({
			ledger,
			uri: "file:///a.md",
			server: { claimed: false, usable: false },
			resolve,
		});
		expect(snapshot.freshness).toBe("no-server");
	});

	it("reports an unusable server with its reason", () => {
		// A server that will not start is inert code that looks live.
		const ledger = new DiagnosticsLedger();
		const snapshot = diagnosticsSnapshot({
			ledger,
			uri: "file:///a.ts",
			server: { claimed: true, usable: false, reason: "typescript-language-server is not installed" },
			resolve,
		});
		expect(snapshot.freshness).toBe("unavailable");
		expect(snapshot.reason).toContain("not installed");
		expect(describeFreshness("unavailable", snapshot.reason)).toContain("not installed");
	});

	it("only claims clean when the server published an empty set", () => {
		// A server that published [] has said so. That is the one case where "no
		// diagnostics" is a fact about the code.
		const ledger = new DiagnosticsLedger();
		ledger.publish("file:///a.ts", []);
		const snapshot = diagnosticsSnapshot({ ledger, uri: "file:///a.ts", server: claimed, resolve });
		expect(snapshot.freshness).toBe("published");
		expect(snapshot.diagnostics).toEqual([]);
	});

	it("returns published diagnostics for the file", () => {
		const ledger = new DiagnosticsLedger();
		ledger.publish("file:///a.ts", [diagnostic(4, "unused variable")]);
		const snapshot = diagnosticsSnapshot({ ledger, uri: "file:///a.ts", server: claimed, resolve });
		expect(snapshot.freshness).toBe("published");
		expect(snapshot.diagnostics[0]?.message).toBe("unused variable");
	});

	it("does not leak another file's diagnostics", () => {
		const ledger = new DiagnosticsLedger();
		ledger.publish("file:///a.ts", [diagnostic(0, "in a")]);
		ledger.publish("file:///b.ts", [diagnostic(0, "in b")]);
		const snapshot = diagnosticsSnapshot({ ledger, uri: "file:///a.ts", server: claimed, resolve });
		expect(snapshot.diagnostics.map((d) => d.message)).toEqual(["in a"]);
	});
});

describe("refreshing after a write", () => {
	it("refreshes when enabled and a server claims the file", () => {
		expect(shouldRefreshAfterWrite({ enabled: true, serverClaimed: true })).toBe(true);
	});

	it("does not refresh when the setting is off", () => {
		// Every write would otherwise cost a round trip for a server that coalesces
		// them anyway.
		expect(shouldRefreshAfterWrite({ enabled: false, serverClaimed: true })).toBe(false);
	});

	it("does not refresh when no server claims the file", () => {
		expect(shouldRefreshAfterWrite({ enabled: true, serverClaimed: false })).toBe(false);
	});
});

describe("the freshness descriptions never claim the code is clean", () => {
	it("for every non-published value", () => {
		for (const freshness of ["pending", "no-server", "unavailable"] as const) {
			// Saying "no diagnostics" here is the failure: it is a claim about the
			// code made by tooling that has not looked.
			expect(describeFreshness(freshness)).not.toMatch(/^no diagnostics/i);
		}
	});
});
