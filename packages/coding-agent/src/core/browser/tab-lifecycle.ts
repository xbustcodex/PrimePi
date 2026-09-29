/**
 * Headless browser tab lifecycle: who owns a tab, when it freezes, when it
 * closes.
 *
 * ## The rule everything else follows from
 *
 * **Only a tab this session launched headlessly is ours to freeze or close.**
 *
 * A browser reached over CDP, through a relay, or spawned by something else is
 * not ours. Closing it would kill a browser another tool, another session, or
 * the user is using. Nor is a tab belonging to a different session even when it
 * is headless: two sessions sharing a machine must not reap each other's tabs.
 *
 * That is why ownership is recorded at open time and checked on every lifecycle
 * decision, rather than inferred from the current state.
 *
 * ## Why freeze rather than close when idle
 *
 * An animated page keeps running timers, compositing frames and burning CPU and
 * GPU while nothing is looking at it. Closing the tab would destroy the state
 * the agent navigated to. **Freezing** stops the page without discarding it, so
 * the next use resumes exactly where it was.
 *
 * A tab can opt out of freezing with `persist: true` at open time - a tab being
 * watched for a change the agent will come back for should keep running.
 *
 * ## Idle close is a reaper, not a policy
 *
 * Closing is bounded by an idle timeout, and `0` means never. Even then, a
 * session dispose reaps what it owns: a headless tab outliving the process that
 * launched it is a leaked browser, and the timeout is about tidiness, not about
 * correctness.
 */

/** How a browser was reached, which determines who owns its tabs. */
export type BrowserLaunch = "headless-owned" | "cdp" | "relay" | "spawned-external";

/** A tab, with the ownership that governs its lifecycle. */
export interface OwnedTab {
	readonly id: string;
	readonly launch: BrowserLaunch;
	/** The session that opened it. */
	readonly sessionId: string;
	readonly openedAtMs: number;
	readonly lastUsedAtMs: number;
	/** Opts the tab out of idle freezing. */
	readonly persist: boolean;
}

/** Whether a tab may be frozen or closed. */
export function isOwnedBy(launch: BrowserLaunch): boolean {
	// Only a headless tab this session launched is ours. A CDP or relay browser is
	// shared; a spawned external one is not ours at all.
	return launch === "headless-owned";
}

/** Whether this session may act on this tab. */
export function mayManage(tab: OwnedTab, currentSessionId: string): boolean {
	// Two sessions sharing a machine must not freeze or close each other's tabs,
	// even when both are headless.
	return isOwnedBy(tab.launch) && tab.sessionId === currentSessionId;
}

/** What a lifecycle pass decided for one tab. */
export type LifecycleAction =
	| { readonly action: "none"; readonly reason: string }
	| { readonly action: "freeze"; readonly reason: string }
	| { readonly action: "close"; readonly reason: string };

export interface LifecycleOptions {
	/** Freeze owned tabs when a turn settles. */
	readonly freezeOnTurnEnd: boolean;
	/** Close owned tabs idle longer than this, in seconds. `0` never closes. */
	readonly idleCloseSec: number;
}

/**
 * Decides what happens to one tab.
 *
 * `turnEnded` distinguishes the two moments. At the end of a turn the tab is
 * merely idle and freezing is the right response — the agent may come back in
 * the next turn. Closing happens only when the tab has been idle across a
 * longer horizon, and only on a sweep.
 */
export function decideTabAction(
	tab: OwnedTab,
	options: LifecycleOptions,
	context: {
		readonly nowMs: number;
		readonly sessionId: string;
		readonly turnEnded: boolean;
		readonly sweeping: boolean;
	},
): LifecycleAction {
	// Ownership first, for every decision. A tab we do not own is never touched,
	// and the reason says so rather than reporting "not idle".
	if (!isOwnedBy(tab.launch)) {
		return { action: "none", reason: `the tab was reached by ${tab.launch}, so it is not ours to manage` };
	}
	if (tab.sessionId !== context.sessionId) {
		return { action: "none", reason: "the tab belongs to another session" };
	}

	const idleMs = context.nowMs - tab.lastUsedAtMs;
	if (options.idleCloseSec > 0 && idleMs >= options.idleCloseSec * 1000 && context.sweeping) {
		// Long-idle and a sweep is the only path that closes. A turn ending is not
		// evidence the agent is finished with the tab.
		return {
			action: "close",
			reason: `idle for ${Math.round(idleMs / 1000)}s, past the ${options.idleCloseSec}s timeout`,
		};
	}

	if (context.turnEnded && options.freezeOnTurnEnd && !tab.persist) {
		// Freezing stops the page without discarding the state the agent navigated
		// to; closing would throw that away.
		return { action: "freeze", reason: "the turn settled and the tab did not opt out of freezing" };
	}

	if (tab.persist && options.freezeOnTurnEnd && context.turnEnded) {
		return { action: "none", reason: "the tab was opened with persist, so it keeps running" };
	}
	return { action: "none", reason: "not idle, or no lifecycle action is due" };
}

/** What a session dispose does, which is independent of the idle timeout. */
export function decideDispose(tab: OwnedTab, currentSessionId: string): LifecycleAction {
	// A headless tab outliving the process that launched it is a leaked browser.
	// The idle timeout is about tidiness; disposal is about correctness.
	if (!isOwnedBy(tab.launch)) return { action: "none", reason: "not ours to close" };
	if (tab.sessionId !== currentSessionId) return { action: "none", reason: "another session owns it" };
	return { action: "close", reason: "the owning session is disposing" };
}

/** Tracks the tabs one session owns. */
export class BrowserTabRegistry {
	readonly #tabs = new Map<string, OwnedTab>();
	readonly #sessionId: string;

	constructor(sessionId: string) {
		this.#sessionId = sessionId;
	}

	/** Records a tab, returning the record with the frozen fields filled in. */
	open(input: { id: string; launch: BrowserLaunch; nowMs: number; persist?: boolean }): OwnedTab {
		const tab: OwnedTab = {
			id: input.id,
			launch: input.launch,
			sessionId: this.#sessionId,
			openedAtMs: input.nowMs,
			lastUsedAtMs: input.nowMs,
			persist: input.persist ?? false,
		};
		this.#tabs.set(tab.id, tab);
		return tab;
	}

	/** Marks a tab as used, which defers both freeze and close. */
	touch(id: string, nowMs: number): void {
		const tab = this.#tabs.get(id);
		if (!tab) return;
		this.#tabs.set(id, { ...tab, lastUsedAtMs: nowMs });
	}

	get(id: string): OwnedTab | undefined {
		return this.#tabs.get(id);
	}

	all(): readonly OwnedTab[] {
		return [...this.#tabs.values()];
	}

	/** Removes a tab, having frozen or closed it. */
	remove(id: string): void {
		this.#tabs.delete(id);
	}

	/** Tabs this session owns, and nothing else. */
	owned(): readonly OwnedTab[] {
		return this.all().filter((tab) => mayManage(tab, this.#sessionId));
	}

	/** Applies a lifecycle decision to every tab and returns what happened. */
	sweep(
		options: LifecycleOptions,
		context: { nowMs: number; turnEnded: boolean; sweeping: boolean },
	): {
		readonly frozen: readonly string[];
		readonly closed: readonly string[];
		readonly skipped: readonly { id: string; reason: string }[];
	} {
		const frozen: string[] = [];
		const closed: string[] = [];
		const skipped: { id: string; reason: string }[] = [];
		for (const tab of this.all()) {
			const decision = decideTabAction(tab, options, { ...context, sessionId: this.#sessionId });
			if (decision.action === "freeze") frozen.push(tab.id);
			else if (decision.action === "close") {
				closed.push(tab.id);
				this.#tabs.delete(tab.id);
			} else skipped.push({ id: tab.id, reason: decision.reason });
		}
		return { frozen, closed, skipped };
	}

	/** Reaps everything this session owns, at dispose. */
	dispose(): readonly string[] {
		const closed: string[] = [];
		for (const tab of this.all()) {
			const decision = decideDispose(tab, this.#sessionId);
			if (decision.action === "close") {
				closed.push(tab.id);
				this.#tabs.delete(tab.id);
			}
		}
		return closed;
	}
}
