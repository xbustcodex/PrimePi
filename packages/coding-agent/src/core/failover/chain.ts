/**
 * Retry fallback chains: an ordered, configured route out of a failed model.
 *
 * ## What this is, relative to what already exists
 *
 * `selectFailoverCandidate` in `packages/ai` answers "given this model failed
 * and these candidates are available, which one should take the turn?" It is
 * Pi's authority, it encodes the paid/credential-free policy, and it is not
 * duplicated here.
 *
 * This layer is only the part that lives *above* it: a user-configured
 * **sequence** of routes, the cursor through that sequence, and the policy for
 * returning to the primary once it recovers. Every candidate the chain
 * proposes is still filtered by `selectFailoverCandidate`, so a chain cannot
 * route around a policy the user set.
 *
 * ## The invariant that matters most
 *
 * **A switch is a routing decision until something is actually produced on
 * the new model.** Until a turn on the fallback target has settled, nothing
 * reports the run as having used it. A session that shows "now on gpt-4o-mini"
 * before any response came back on that model is telling the user a thing that
 * is not yet true — and if the fallback then fails too, they were told about a
 * model that never ran.
 *
 * ## Why chains are ordered rather than a set
 *
 * A set gives no way to express "try the cheap sibling first, the expensive
 * one only if that fails". The order is the user's cost and quality preference,
 * and reordering it silently would override a decision they made explicitly.
 */

import type { Api, AvailabilityCooldowns, Model } from "@earendil-works/pi-ai";
import {
	type FailoverCandidateInput,
	type FailoverDecision,
	type FailoverPolicy,
	selectFailoverCandidate,
	type TurnRequirements,
} from "@earendil-works/pi-ai";

/** Ordered routes, keyed by role name or model selector. */
export type FallbackChains = Readonly<Record<string, readonly string[]>>;

/**
 * When to return to the primary model.
 *
 * - `never` — stay on the fallback for the rest of the session. A run that
 *   oscillates between models on every recovery is worse than one that settles.
 * - `cooldown-expiry` — return once the primary's cooldown has lapsed, so a
 *   transient failure does not permanently downgrade the session.
 */
export type RevertPolicy = "never" | "cooldown-expiry";

/** A parsed `provider/id` route. */
export interface RouteSelector {
	readonly provider: string;
	readonly id: string;
	/** The selector as written, kept for messages and for round-tripping. */
	readonly raw: string;
}

/**
 * Parses a route selector.
 *
 * Returns `undefined` rather than throwing: a chain is user-editable JSON, and
 * one malformed entry must not prevent the rest of the chain from working. The
 * malformed entry is skipped and the chain continues.
 */
export function parseRouteSelector(value: string): RouteSelector | undefined {
	const raw = value.trim();
	if (raw.length === 0) return undefined;
	// The first `/` only: a model id may itself contain one, and a naive split
	// on the last separator would route to a provider that does not exist.
	const separator = raw.indexOf("/");
	if (separator <= 0 || separator === raw.length - 1) return undefined;
	const provider = raw.slice(0, separator);
	const id = raw.slice(separator + 1);
	if (provider.length === 0 || id.length === 0) return undefined;
	return { provider, id, raw };
}

/** Resolves a `provider/id` route to a model, or `undefined` if it is unknown. */
export type RouteLookup = (provider: string, id: string) => Model<Api> | undefined;

/** Why a chain could not be used. Distinct from a chain that yielded no candidate. */
export interface ChainFailure {
	readonly ok: false;
	readonly unavailable: ChainUnavailable;
}

export type ChainUnavailable =
	| { kind: "disabled" }
	| { kind: "no-chain"; forRole: string }
	| { kind: "exhausted"; chainKey: string; considered: number; blocked: string[] };

export interface ChainResolution {
	readonly ok: true;
	/** The model that should take the turn. */
	readonly decision: FailoverDecision;
	/** The chain entry the decision came from, for a user-facing notice. */
	readonly route: RouteSelector;
	/** The chain key, so the state knows which cursor to advance. */
	readonly chainKey: string;
	/** Index of the entry chosen, so the next failure resumes after it. */
	readonly index: number;
}

export interface ChainState {
	/** Which chain key produced the current fallback. */
	readonly chainKey: string;
	/** Index into that chain of the entry currently in use. */
	readonly index: number;
	/** The route to return to once the primary recovers. */
	readonly primary: RouteSelector;
	/** True once a turn on the fallback has actually settled. */
	readonly served: boolean;
	/** The failure that started the fallback, for diagnostics. */
	readonly reason?: string;
}

export interface ResolveFallbackInput {
	/** The model that just failed. */
	readonly failed: Model<Api>;
	/** The role the session is running, used to pick a chain. */
	readonly role: string;
	/** The primary for that role, i.e. where to return to. */
	readonly primary: RouteSelector;
	readonly chains: FallbackChains;
	readonly lookup: RouteLookup;
	readonly policy: FailoverPolicy;
	readonly requirements: TurnRequirements;
	readonly cooldowns: AvailabilityCooldowns;
	/** Routes already attempted this turn, so a chain cannot loop. */
	readonly attempted: ReadonlySet<string>;
	/** Where the cursor currently sits, if a fallback is already active. */
	readonly state?: ChainState;
	readonly now: number;
}

/** The key used in an `attempted` set and in a chain entry. */
function selectorKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/**
 * Resolves the next fallback for a turn, advancing through the chain.
 *
 * ## Why a chain walks forward rather than restarting
 *
 * Restarting from the head of the chain after each failure means a run whose
 * first two routes are permanently down pays their timeout on every single
 * turn, forever. Advancing the cursor means each route is tried once per
 * incident, and the chain position is the record of what has already been
 * ruled out.
 *
 * ## Why every candidate still passes through `selectFailoverCandidate`
 *
 * A chain is a *preference order*, not a permission. If the user configured
 * `free-only`, a chain naming a paid model must not route around that — the
 * chain proposes, the policy disposes. Routing a chain past the policy would
 * make the paid/credential-free authority decorative.
 */
export function resolveFallbackChain(input: ResolveFallbackInput): ChainResolution | ChainFailure {
	const { failed, chains, lookup, policy, requirements, cooldowns, attempted, now } = input;

	if (policy === "off") return { ok: false, unavailable: { kind: "disabled" } };

	const chainKey = input.state?.chainKey ?? input.role;
	const entries = chains[chainKey] ?? chains.default;
	if (!entries || entries.length === 0) {
		return { ok: false, unavailable: { kind: "no-chain", forRole: chainKey } };
	}

	// Start where the cursor left off. A fresh chain starts at its head; an
	// in-progress one resumes, so a route already ruled out is not retried.
	const start = input.state ? input.state.index : 0;
	const blocked: string[] = [];
	let considered = 0;

	for (let offset = 0; offset < entries.length; offset++) {
		const index = (start + offset) % entries.length;
		const entry = entries[index]!;
		const selector = parseRouteSelector(entry);
		if (!selector) {
			// A malformed entry is skipped, not fatal: a chain is hand-edited JSON
			// and one bad line must not disable the routes after it.
			blocked.push(entry);
			continue;
		}
		// Never re-propose the model that just failed, and never revisit a route
		// already tried this turn. Either would make the chain loop.
		if (selector.provider === failed.provider && selector.id === failed.id) continue;
		if (attempted.has(selectorKey(selector.provider, selector.id))) continue;

		const model = lookup(selector.provider, selector.id);
		if (!model) {
			blocked.push(entry);
			continue;
		}
		considered++;

		const candidates: FailoverCandidateInput[] = [{ model }];
		const decision = selectFailoverCandidate({
			failed,
			policy,
			candidates,
			requirements,
			cooldowns,
			attempted,
			now,
		});
		if ("unavailable" in decision) {
			// The policy refused this route. Recorded, then the chain moves on.
			blocked.push(entry);
			continue;
		}
		return {
			ok: true,
			decision,
			route: selector,
			chainKey,
			index,
		};
	}

	return {
		ok: false,
		unavailable: {
			kind: "exhausted",
			chainKey,
			considered,
			blocked,
		},
	};
}

/**
 * Whether the session should return to its primary now.
 *
 * Two conditions, both required: the policy permits reverting, and the primary
 * is actually healthy again. Reverting into a cooldown would immediately fail
 * again and burn another fallback, which is the loop this exists to prevent.
 */
export function shouldRevertToPrimary(input: {
	readonly state: ChainState;
	readonly revertPolicy: RevertPolicy;
	readonly primaryCooldownUntil: number | undefined;
	readonly now: number;
}): boolean {
	if (input.revertPolicy === "never") return false;
	if (input.state.index <= 0) return false;
	const until = input.primaryCooldownUntil;
	// No cooldown recorded means the primary is not known to be in trouble, which
	// is the case the policy exists to return to.
	if (until === undefined) return true;
	return input.now >= until;
}

/**
 * Marks a fallback as having actually served a turn.
 *
 * Separate from the switch itself because the two are different claims. The
 * switch says "this is where the next request will go". This says "a response
 * came back from here". Collapsing them lets a session report a model that
 * never produced anything.
 */
export function markServed(state: ChainState): ChainState {
	return { ...state, served: true };
}

/** Why the state exists, stated for whoever debugs a surprising switch. */
export function describeFallback(state: ChainState): string {
	return state.served
		? `falling back to ${state.chainKey}[${state.index}]${state.reason ? ` after ${state.reason}` : ""}`
		: `switching to ${state.chainKey}[${state.index}]${state.reason ? ` after ${state.reason}` : ""}`;
}
