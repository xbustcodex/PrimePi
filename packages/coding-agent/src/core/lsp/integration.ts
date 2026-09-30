/**
 * LSP integration: when diagnostics are gathered, and what survives to the model.
 *
 * ## Why this exists
 *
 * PrimePi has a complete LSP subsystem — client, manager, operations — that no
 * production path constructed. `LspManager` had one caller: its own test. Six
 * settings were registered and marked wired: the language server ran, never.
 *
 * ## Diagnostics are deferred, never synchronous
 *
 * An LSP server publishes diagnostics asynchronously, and the latency is
 * unbounded: a cold server on a large project can take seconds. So a diagnostic
 * fetched inline would either block a tool call for an unbounded time or report
 * an empty set that later fills in.
 *
 * The resolution is to return whatever has been published *now*, and to make the
 * staleness visible. A model told "no diagnostics" when the server has not
 * finished is worse than one told "none published yet" — the first is a claim
 * about the code, the second is a claim about the tooling.
 *
 * ## Superseded diagnostics are dropped per file
 *
 * A file edited twice publishes twice. Keeping both shows the same error twice
 * at two line positions, and the model acts on the stale one. So the ledger
 * keeps only the newest publication per URI, and a file that stops reporting is
 * dropped rather than left to age.
 *
 * ## A failure is reported, not swallowed
 *
 * A server that will not start is inert code that looks live. Every resolution
 * carries a reason, so a caller can surface "typescript-language-server is not
 * installed" rather than silently having no diagnostics forever.
 */

import type { LspDiagnostic, ResolvedDiagnostic } from "./operations.ts";

/** How fresh a diagnostic set is when it reaches the model. */
export type DiagnosticsFreshness =
	/** The server published for this file. */
	| "published"
	/** The server has not published for this file yet. */
	| "pending"
	/** No server claims this file. */
	| "no-server"
	/** A server claims it but is not usable. */
	| "unavailable";

export interface DiagnosticsSnapshot {
	readonly freshness: DiagnosticsFreshness;
	readonly diagnostics: readonly ResolvedDiagnostic[];
	/** Present when freshness is `unavailable`, so the reason is visible. */
	readonly reason?: string;
}

/**
 * The published-diagnostics ledger for one session.
 *
 * Keyed by URI, newest publication wins. A bounded map so a long session across
 * many files cannot grow without limit; eviction drops the oldest publication,
 * which makes those files report `pending` again rather than wrong.
 */
export class DiagnosticsLedger {
	readonly #published = new Map<string, readonly LspDiagnostic[]>();
	readonly #capacity: number;

	constructor(capacity = 512) {
		this.#capacity = Math.max(1, Math.trunc(capacity));
	}

	get size(): number {
		return this.#published.size;
	}

	/**
	 * Records a publication, replacing any earlier one for the same URI.
	 *
	 * Replacing rather than appending is the point: a file edited twice publishes
	 * twice, and showing both would put the same error at two line positions with
	 * the model free to act on the stale one.
	 */
	publish(uri: string, diagnostics: readonly LspDiagnostic[]): void {
		// Re-insert so the newest publication is last and eviction drops the oldest,
		// which is the one least likely to still describe the file.
		this.#published.delete(uri);
		this.#published.set(uri, [...diagnostics]);
		while (this.#published.size > this.#capacity) {
			const oldest = this.#published.keys().next();
			if (oldest.done) break;
			this.#published.delete(oldest.value);
		}
	}

	/** The newest publication for a URI. */
	get(uri: string): readonly LspDiagnostic[] | undefined {
		return this.#published.get(uri);
	}

	/**
	 * Drops a publication, for a file the model just changed.
	 *
	 * The server will republish; until it does the file reports `pending` rather
	 * than diagnostics computed against content that no longer exists.
	 */
	drop(uri: string): void {
		this.#published.delete(uri);
	}

	clear(): void {
		this.#published.clear();
	}
}

/**
 * Builds what the model is told about a file's diagnostics.
 *
 * ## Why an empty set is never reported as "no problems"
 *
 * Three of the four outcomes are *not* a statement about the code, and saying
 * "no diagnostics" for any of them teaches the model the file is clean when the
 * truth is that nothing has looked yet. Only `published` with an empty array
 * makes that claim, and only because a server that published an empty set has
 * said so.
 */
export function diagnosticsSnapshot(input: {
	readonly ledger: DiagnosticsLedger;
	readonly uri: string;
	/** Whether a server claims the file, and whether it is usable. */
	readonly server: { claimed: boolean; usable: boolean; reason?: string };
	readonly resolve: (uri: string, diagnostics: readonly LspDiagnostic[]) => readonly ResolvedDiagnostic[];
}): DiagnosticsSnapshot {
	if (!input.server.claimed) {
		return { freshness: "no-server", diagnostics: [] };
	}
	if (!input.server.usable) {
		// A server that will not start is inert code that looks live, so the reason
		// travels with the answer.
		return {
			freshness: "unavailable",
			diagnostics: [],
			...(input.server.reason ? { reason: input.server.reason } : {}),
		};
	}
	const published = input.ledger.get(input.uri);
	if (published === undefined) {
		// "Nothing has looked yet" rather than "nothing found". The distinction is the
		// whole point of deferring.
		return { freshness: "pending", diagnostics: [] };
	}
	return { freshness: "published", diagnostics: input.resolve(input.uri, published) };
}

/** The sentence a model reads for a freshness value. */
export function describeFreshness(freshness: DiagnosticsFreshness, reason?: string): string {
	switch (freshness) {
		case "published":
			return "Diagnostics below are from the language server.";
		case "pending":
			// The honest form: no claim about the code at all.
			return "The language server has not reported diagnostics for this file yet.";
		case "no-server":
			return "No language server claims this file.";
		case "unavailable":
			return `The language server for this file is not usable${reason ? `: ${reason}` : ""}.`;
	}
}

/**
 * Whether a write should trigger a diagnostics refresh.
 *
 * Refreshing on every write costs a round trip per keystroke-batch for a server
 * that will coalesce them anyway; never refreshing leaves the model reasoning
 * about diagnostics computed before its own edit.
 */
export function shouldRefreshAfterWrite(input: {
	readonly enabled: boolean;
	readonly serverClaimed: boolean;
}): boolean {
	return input.enabled && input.serverClaimed;
}
