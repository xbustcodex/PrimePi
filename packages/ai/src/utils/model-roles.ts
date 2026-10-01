/**
 * Model roles: a named, ordered set of model *preferences* rather than a single model.
 *
 * A role answers "which model should be used for this kind of work" and expands to an
 * ordered candidate list. The list is only a preference: a role never establishes
 * that a model is usable. Every candidate a caller acts on must still clear the
 * existing access, credential, compatibility, availability, and failure-scope
 * machinery, with `selectFailoverCandidate` remaining the final eligibility
 * authority. That separation is deliberate: a role can propose a model it cannot
 * reach, and the existing gates are what stop it.
 *
 * Two invariants this module owns, because they are the parts a role system is most
 * likely to erode:
 *
 *  - **Free stays free.** When the session is running a free model under a policy
 *    that forbids paid routes, expansion drops every non-free candidate before the
 *    caller sees it. OMP has no price filter at all, so this gate is Pi-native and
 *    mandatory rather than inherited.
 *  - **Termination.** Alias and inheritance expansion is cycle-safe and bounded.
 *    A self-referential or missing alias resolves to "no candidates" deterministically
 *    instead of searching forever.
 */

import type { Api, Model } from "../types.ts";
import { policyAllowsPaid } from "./failover.ts";
import { isAnonymouslyAccessible, isCredentialFree } from "./free-model.ts";
import type { RoleThinkingLevel } from "./thinking-level-vocab.ts";
// Imported for local use (a re-export does not bind a name in this module) and
// re-exported below for the existing public surface.
import { isThinkingLevel } from "./thinking-level-vocab.ts";

/**
 * The complete role vocabulary, declared up front so that adding a consumer later
 * needs no schema migration. A role is only ever *offered* when `activeInPi` is set,
 * which means Pi has a real runtime consumer for it today.
 */
export const MODEL_ROLE_IDS = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
] as const;

export type ModelRole = (typeof MODEL_ROLE_IDS)[number];

/** Roles whose consumers are chat turns, as opposed to a non-chat model kind. */
export type ChatModelRole = Extract<
	ModelRole,
	"default" | "smol" | "slow" | "vision" | "plan" | "commit" | "tiny" | "memory" | "task" | "advisor"
>;

export function isModelRole(value: string): value is ModelRole {
	return (MODEL_ROLE_IDS as readonly string[]).includes(value);
}

/**
 * Accepts every candidate a role can be handed.
 *
 * `Model<Api>` is already Pi's chat shape: `type` is `"chat"` when present, and image
 * and classifier entries have their own types, so they cannot appear in a role
 * candidate list. Chat-ness is therefore a type-level fact rather than a runtime
 * comparison. A non-chat role must narrow explicitly in its own `accepts`.
 */
function isChatModel(_model: Model<Api>): boolean {
	return true;
}

/**
 * When a role falls back to another role that is itself unconfigured. Mirrors OMP's
 * `ROLE_CONFIGURED_FALLBACK`: `configuredOnly` restricts the fallback to cases where
 * the target role has an explicit value, so a role never silently borrows a default
 * it was meant to be independent of.
 */
interface RoleFallback {
	role: ModelRole;
	configuredOnly?: boolean;
}

export interface ModelRoleInfo {
	/** Short tag, matching OMP's picker badge. */
	tag: string;
	/** Human label. */
	name: string;
	section: "chat" | "kind";
	/** Eligibility predicate. Roles with no Pi-side kind support never accept anything. */
	accepts: (model: Model<Api>) => boolean;
	/** True only when Pi has a genuine runtime consumer today. */
	activeInPi: boolean;
	configuredFallback?: RoleFallback;
	/**
	 * Whether the role consults the configured `default` before its own chain. OMP
	 * enables this for `smol` and `slow` only.
	 */
	inheritDefaultBeforeChain?: boolean;
	/** Built-in preference chain, consulted when nothing is configured. */
	priorityChain: readonly string[];
	/** What consumes this role in Pi, for the activation table below. */
	consumer?: string;
}

/**
 * Built-in preference chains, ported from OMP's `priority.json`.
 *
 * Patterns are matched most-specific-first against `provider/id`, then bare ids, so a
 * chain entry naming a model Pi's catalog does not carry simply never matches rather
 * than throwing.
 */
const SMOL_CHAIN: readonly string[] = [
	"google-antigravity/gemini-3.8-flash",
	"gemini-3.8-flash",
	"gemini-3-7-flash",
	"gemini-3-6-flash",
	"gemini-3-5-flash",
	"openai-codex/gpt-5.3-codex-spark",
	"5.3-spark",
	"zai/glm-5.3-flash",
	"glm-5.3-flash",
	"gemini-3.1-flash-lite",
	"gemini-3-1-flash-lite",
	"flash-lite",
	"cerebras/gpt-oss-120b",
	"gpt-oss-120b",
	"cerebras/zai-glm-4.7",
	"cerebras/zai-glm-4.6",
	"claude-haiku-4-5",
	"haiku-4-5",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.4-mini",
];

const SLOW_CHAIN: readonly string[] = [
	"openai-codex/gpt-5.6-sol",
	"anthropic/claude-fable-5-1",
	"kimi-code/k3",
	"zai/glm-5.3",
	"anthropic/claude-opus-5-5",
	"anthropic/claude-opus-5",
	"openai-codex/gpt-5.5",
	"anthropic/claude-opus-4-8",
];

const IMAGE_CHAIN: readonly string[] = [
	"openai/gpt-image-1",
	"google-antigravity/gemini-3-pro-image",
	"xai/grok-imagine-image",
	"openrouter/google/gemini-3-pro-image-preview",
];

const WEB_CHAIN: readonly string[] = [
	"google/gemini-2.5-flash",
	"anthropic/claude-haiku-4-5",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.6",
	"openai-codex/gpt-5.5",
	"xai/grok-4.5",
];

const SPEECH_CHAIN: readonly string[] = ["xai/grok-tts", "xai-oauth/grok-tts"];

const DICTATION_CHAIN: readonly string[] = ["openai/gpt-4o-transcribe"];

const JUDGE_CHAIN: readonly string[] = ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"];

export const MODEL_ROLES: Readonly<Record<ModelRole, ModelRoleInfo>> = {
	default: {
		tag: "DEFAULT",
		name: "Default",
		section: "chat",
		accepts: isChatModel,
		// The default role is the live session model, so it is always available.
		activeInPi: true,
		consumer: "startup model resolution and session restore",
		priorityChain: [],
	},
	smol: {
		tag: "SMOL",
		name: "Fast",
		section: "chat",
		accepts: isChatModel,
		activeInPi: true,
		consumer: "compaction and branch summarisation",
		inheritDefaultBeforeChain: true,
		priorityChain: SMOL_CHAIN,
	},
	slow: {
		tag: "SLOW",
		name: "Thinking",
		section: "chat",
		accepts: isChatModel,
		// Inactive: OMP routes `slow` to the advisor, reviewer subagent, commit agent,
		// edit auto-repair, and skill summarisation. Pi has none of those, so wiring it
		// now would be a control with no consumer.
		activeInPi: false,
		inheritDefaultBeforeChain: true,
		priorityChain: SLOW_CHAIN,
	},
	vision: {
		tag: "VISION",
		name: "Vision",
		section: "chat",
		accepts: isChatModel,
		activeInPi: false,
		priorityChain: [],
	},
	plan: {
		tag: "PLAN",
		name: "Architect",
		section: "chat",
		accepts: isChatModel,
		// Active: plan mode resolves this role on entry. It resolves through the
		// normal chain path, so a role candidate is still only a *proposal* — the
		// access, credential, free-only, and cooldown gates that govern every other
		// role apply here unchanged, and an unusable candidate yields no model rather
		// than one that bypasses them.
		activeInPi: true,
		consumer: "plan mode model transition on entry",
		priorityChain: [],
	},
	commit: {
		tag: "COMMIT",
		name: "Commit",
		section: "chat",
		accepts: isChatModel,
		activeInPi: false,
		priorityChain: [],
	},
	tiny: {
		tag: "TINY",
		name: "Tiny",
		section: "chat",
		accepts: isChatModel,
		activeInPi: false,
		configuredFallback: { role: "smol" },
		priorityChain: [],
	},
	memory: {
		tag: "MEMORY",
		name: "Memory",
		section: "chat",
		accepts: isChatModel,
		activeInPi: false,
		configuredFallback: { role: "smol" },
		priorityChain: [],
	},
	task: {
		tag: "TASK",
		name: "Subtask",
		section: "chat",
		accepts: isChatModel,
		// Inactive until a first-class subagent tool exists to consume it.
		activeInPi: false,
		priorityChain: [],
	},
	advisor: {
		tag: "ADVISOR",
		name: "Advisor",
		section: "chat",
		accepts: isChatModel,
		activeInPi: false,
		configuredFallback: { role: "slow", configuredOnly: true },
		priorityChain: [],
	},
	image: {
		tag: "IMAGE",
		name: "Image generation",
		section: "kind",
		// Inactive: image models are `ImageModel`, not `Model`, so Pi's role resolver
		// does not carry them yet. Re-enables when a non-chat candidate type lands.
		accepts: () => false,
		activeInPi: false,
		priorityChain: IMAGE_CHAIN,
	},
	web: {
		tag: "WEB",
		name: "Web search",
		section: "kind",
		// Requires a `search` model kind or a webSearch capability, neither of which
		// Pi's catalog carries yet.
		accepts: () => false,
		activeInPi: false,
		priorityChain: WEB_CHAIN,
	},
	speech: {
		tag: "SPEECH",
		name: "Speech",
		section: "kind",
		// Requires a `tts` model kind; speech is otherwise out of scope.
		accepts: () => false,
		activeInPi: false,
		priorityChain: SPEECH_CHAIN,
	},
	dictation: {
		tag: "DICTATION",
		name: "Dictation",
		section: "kind",
		// Requires an `stt` model kind; speech is otherwise out of scope.
		accepts: () => false,
		activeInPi: false,
		priorityChain: DICTATION_CHAIN,
	},
	judge: {
		tag: "JUDGE",
		name: "Judge",
		section: "kind",
		// Requires a `judge`/`tiny` model kind; no judge consumer in Pi yet.
		accepts: () => false,
		activeInPi: false,
		priorityChain: JUDGE_CHAIN,
	},
};

/** Roles that are safe to resolve today because Pi has a real consumer. */
export function activeRoles(): readonly ModelRole[] {
	return MODEL_ROLE_IDS.filter((role) => MODEL_ROLES[role].activeInPi);
}

// --- Alias grammar ------------------------------------------------------------

const ROLE_ALIAS_PREFIX = "@";
const LEGACY_ROLE_ALIAS_PREFIX = "pi/";
/** OMP's shorthand for the default role. */
export const DEFAULT_ROLE_ALIAS = "*";

/**
 * Resolves a role selector to a role id.
 *
 * Accepts a bare role id, `@role`, `pi/role`, and `*`. Anything else is rejected so a
 * typo cannot silently resolve to a different role.
 */
export function resolveRoleAlias(value: string, known: ReadonlySet<string>): ModelRole | undefined {
	const trimmed = value.trim();
	if (trimmed === DEFAULT_ROLE_ALIAS) return "default";
	const candidate = trimmed.startsWith(ROLE_ALIAS_PREFIX)
		? trimmed.slice(ROLE_ALIAS_PREFIX.length)
		: trimmed.startsWith(LEGACY_ROLE_ALIAS_PREFIX)
			? trimmed.slice(LEGACY_ROLE_ALIAS_PREFIX.length)
			: trimmed;
	if (!isModelRole(candidate) || !known.has(candidate)) return undefined;
	return candidate;
}

/** True when the value is spelled as a role alias rather than a model pattern. */
export function isRoleAlias(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed === DEFAULT_ROLE_ALIAS ||
		trimmed.startsWith(ROLE_ALIAS_PREFIX) ||
		trimmed.startsWith(LEGACY_ROLE_ALIAS_PREFIX)
	);
}

// --- Chain expansion ----------------------------------------------------------

/**
 * Expands one role's configured value into an ordered pattern list.
 *
 * A configured value may itself be a comma-separated list, and any element may be a
 * role alias, so expansion is recursive. `visited` bounds it: a cycle
 * (`smol = "@slow"`, `slow = "@smol"`) terminates instead of recursing, and a
 * self-reference (`smol = "@smol"`) is dropped on sight.
 */
export function expandRolePatterns(input: {
	role: ModelRole;
	/** Explicit per-role configuration, e.g. `{ smol: "@tiny, xai/grok-4.5" }`. */
	configured: Readonly<Record<string, string>>;
	knownRoles: ReadonlySet<string>;
	visited?: Set<string>;
	depth?: number;
}): string[] {
	const { role, configured, knownRoles } = input;
	const visited = input.visited ?? new Set<string>();
	const depth = input.depth ?? 0;
	// Hard depth bound as a second line of defence alongside `visited`.
	if (depth > MODEL_ROLE_IDS.length) return [];
	if (visited.has(role)) return [];
	visited.add(role);

	const info = MODEL_ROLES[role];
	const own = configured[role]?.trim();
	const defaultConfigured = configured.default?.trim();
	const patterns: string[] = [];

	const pushConfigured = (value: string) => {
		for (const part of value.split(",")) {
			const element = part.trim();
			if (!element) continue;
			if (isRoleAlias(element)) {
				const aliased = resolveRoleAlias(element, knownRoles);
				// An unresolvable alias contributes nothing rather than falling back to
				// a guess, so a typo produces no candidates instead of the wrong model.
				if (!aliased) continue;
				patterns.push(...expandRolePatterns({ role: aliased, configured, knownRoles, visited, depth: depth + 1 }));
				continue;
			}
			patterns.push(element);
		}
	};

	if (own) {
		pushConfigured(own);
	} else {
		const fallback = info.configuredFallback;
		const fallbackUsable =
			fallback !== undefined && (!fallback.configuredOnly || Boolean(configured[fallback.role]?.trim()));
		if (fallbackUsable && fallback) {
			pushConfigured(configured[fallback.role]?.trim() || formatRoleAlias(fallback.role));
		} else if (info.inheritDefaultBeforeChain && defaultConfigured) {
			// Only roles OMP marks as default-inheriting consult the configured default
			// first. This is what makes an unconfigured `smol` follow the user's model
			// rather than jumping to a built-in chain entry.
			pushConfigured(defaultConfigured);
		}
	}

	if (patterns.length === 0) {
		patterns.push(...info.priorityChain);
	}
	return patterns;
}

/** Canonical spelling of a role alias, used when synthesising one. */
export function formatRoleAlias(role: ModelRole): string {
	return `${ROLE_ALIAS_PREFIX}${role}`;
}

// --- Candidate resolution -----------------------------------------------------

export interface RoleResolutionInput {
	role: ModelRole;
	/** Explicit per-role configuration from settings. */
	configured: Readonly<Record<string, string>>;
	/** Models the runtime currently offers, already auth/availability filtered. */
	available: readonly Model<Api>[];
	/**
	 * The live session model. Used for inheritance and to decide whether the session is
	 * on a free route, which gates paid candidates.
	 */
	sessionModel?: Model<Api>;
	/**
	 * Whether paid routes may be selected. Read from the caller's failover policy via
	 * `policyAllowsPaid`, so the role layer cannot be more permissive than failover.
	 */
	policy: "off" | "same-provider" | "free-only" | "compatible";
	/** True when a credential is absent for the given provider. */
	credentialMissing?: (provider: string) => boolean;
}

export interface RoleResolution {
	role: ModelRole;
	/** Ordered candidates that survived every role-level filter. */
	candidates: Model<Api>[];
	/** Patterns the role expanded to, before model matching, for diagnostics. */
	patterns: string[];
	/** Why the list is empty, when it is. */
	emptyReason?: "unresolved" | "inactive-role" | "policy-blocked" | "no-credential" | "no-match";
}

function matchesPattern(model: Model<Api>, pattern: string): boolean {
	const qualified = `${model.provider}/${model.id}`;
	if (qualified === pattern) return true;
	// A bare pattern matches on id only, and tolerates an Ollama-style `:tag` suffix.
	return model.id === pattern || model.id.startsWith(`${pattern}:`);
}

/**
 * Resolves a role to an ordered candidate list.
 *
 * This never asserts usability. It applies only the filters a role owns:
 * activity, kind eligibility, the free-stays-free gate, and credential reachability.
 * Capability, availability, and failure-scope checks remain the caller's, and
 * `selectFailoverCandidate` stays the final gate.
 */
export function resolveRoleCandidates(input: RoleResolutionInput): RoleResolution {
	const { role, configured, available, sessionModel, policy } = input;
	const info = MODEL_ROLES[role];
	const knownRoles = new Set<string>(Object.keys(configured).filter((key) => isModelRole(key)));

	if (!info.activeInPi) {
		return { role, candidates: [], patterns: [], emptyReason: "inactive-role" };
	}

	const patterns = expandRolePatterns({ role, configured, knownRoles });
	if (patterns.length === 0) {
		return { role, candidates: [], patterns, emptyReason: "unresolved" };
	}

	// Free stays free. A free session under a policy that forbids paid routes must not
	// cross into a paid candidate, even when the chain lists one first. A configured
	// default of `*` means "inherit", not "any model", so it never widens the gate.
	const freeSession = sessionModel?.free === true;
	const allowPaid = policyAllowsPaid(policy) || !freeSession;

	const candidates: Model<Api>[] = [];
	const seen = new Set<string>();
	let blockedByPolicy = false;
	let blockedByCredential = false;

	for (const pattern of patterns) {
		for (const model of available) {
			if (!info.accepts(model)) continue;
			if (!matchesPattern(model, pattern)) continue;
			const key = `${model.provider}:${model.id}`;
			if (seen.has(key)) continue;
			// A configured alias resolves to a role, not a literal model name, so a
			// pattern that happens to equal a role id must not match a model by accident.
			if (isRoleAlias(pattern)) continue;

			if (!allowPaid && model.free !== true) {
				blockedByPolicy = true;
				continue;
			}
			// Credential reachability: an anonymous model needs none; anything else needs
			// a configured credential for its provider. This is a role-level filter only;
			// the caller still re-checks before acting.
			if (!isCredentialFree(model) && !isAnonymouslyAccessible(model.provider, model.id)) {
				if (input.credentialMissing?.(model.provider) ?? true) {
					blockedByCredential = true;
					continue;
				}
			}

			seen.add(key);
			candidates.push(model);
		}
	}

	if (candidates.length > 0) return { role, candidates, patterns };

	return {
		role,
		candidates,
		patterns,
		emptyReason: blockedByPolicy ? "policy-blocked" : blockedByCredential ? "no-credential" : "no-match",
	};
}

// `RoleThinkingLevel` is used below, in the resolved-candidate shape. The vocabulary
// itself is re-exported from `thinking-level-vocab.ts` — a leaf with no imports — so
// that `thinking-level.ts` can use it without pulling `failover.ts` and
// `free-model.ts` in through this module. The barrel re-exports it from there.

/**
 * Thinking configuration attached to a resolved candidate.
 *
 * This is metadata about *how* to talk to a model, not a statement about *which*
 * model to use: carrying a level never changes a candidate's eligibility, and a
 * candidate with no level is no less eligible than one that has it.
 */
export interface CandidateThinking {
	/** The level requested via a selector suffix, absent when none was given. */
	level?: RoleThinkingLevel;
	/** The selector the level was parsed from, for diagnostics. */
	source?: string;
}

/**
 * A pattern paired with the metadata parsed off it.
 *
 * The suffix is stripped before matching, so `@smol:high` matches exactly what
 * `@smol` matches. That is the point: the suffix is metadata, so it must not
 * narrow the candidate set.
 */
export interface AnnotatedPattern {
	pattern: string;
	thinking: CandidateThinking;
}

/**
 * Splits a trailing `:level` off a selector.
 *
 * The colon is only a suffix when it follows the alias prefix, so `@smol:high`
 * splits while a bare `pi/smol:high` does not split on the wrong colon. A
 * malformed suffix is dropped rather than treated as part of the model id, so a
 * typo cannot silently resolve to a different model than intended.
 */
export function splitThinkingSuffix(value: string): AnnotatedPattern {
	const trimmed = value.trim();
	const colonIndex = trimmed.lastIndexOf(":");
	if (colonIndex <= 0) return { pattern: trimmed, thinking: {} };

	const base = trimmed.slice(0, colonIndex);
	const suffix = trimmed.slice(colonIndex + 1);
	// `@role:level` and `pi/role:level` both have their colon after the prefix.
	if (base.length === 0 || !isRoleAlias(trimmed)) {
		// Not alias-shaped, so a colon is only a suffix when what precedes it could be
		// a model reference. `provider/id:level` qualifies; a bare `llama3:8b` does
		// not, because that colon belongs to the model id.
		if (colonIndex < trimmed.lastIndexOf("/") + 1) return { pattern: trimmed, thinking: {} };
	}

	if (isThinkingLevel(suffix)) return { pattern: base, thinking: { level: suffix, source: trimmed } };
	// A recognized-but-unsupported or misspelled level contributes no level, and the
	// suffix is not folded into the pattern. Deterministic, and never a surprise match.
	return { pattern: trimmed, thinking: {} };
}

// --- Eligibility -------------------------------------------------------------

/**
 * Hard constraints. A candidate failing any of these is removed.
 *
 * Nothing in this object expresses a preference, and nothing in here can be
 * overridden by ordering: exclusion is not a ranking signal.
 */
export interface RoleEligibility {
	/** The live session model, used to decide whether paid routes are reachable. */
	sessionModel?: Model<Api>;
	/**
	 * Whether paid routes may be used, read from the caller's failover policy.
	 * Defaults to forbidding paid routes, because a chain that does not say
	 * otherwise is not permitted to spend money on its own.
	 */
	policy?: "off" | "same-provider" | "free-only" | "compatible";
	/** True when a credential is absent for the given provider. */
	credentialMissing?: (provider: string) => boolean;
	/** Provider ids excluded by configuration. A hard exclusion. */
	disabledProviders?: ReadonlySet<string>;
	/**
	 * Model selectors that are allowed. Non-empty acts as an allowlist: a model
	 * matching no pattern is excluded. Empty means no allowlist.
	 */
	enabledModelPatterns?: readonly string[];
	/**
	 * Whether a model speaks the API the caller's turn needs. A capability
	 * constraint, not a preference.
	 */
	accepts?: (model: Model<Api>) => boolean;
}

/** Why a candidate was removed, for diagnostics and tests. */
export type IneligibleReason =
	| "role-inactive"
	| "disabled-provider"
	| "not-allowlisted"
	| "kind-ineligible"
	| "policy-paid"
	| "missing-credential";

/** A candidate that was removed, with the reason, so nothing fails silently. */
export interface RejectedCandidate {
	model: Model<Api>;
	reason: IneligibleReason;
}

/**
 * Applies every hard constraint to one model.
 *
 * Ordered cheapest-and-most-decisive first so a disabled provider is not reported
 * as missing credentials, which would be a misleading diagnostic.
 */
export function evaluateEligibility(
	model: Model<Api>,
	role: ModelRole,
	eligibility: RoleEligibility,
): IneligibleReason | undefined {
	if (!MODEL_ROLES[role].activeInPi) return "role-inactive";
	if (eligibility.disabledProviders?.has(model.provider)) return "disabled-provider";
	if (
		eligibility.enabledModelPatterns &&
		eligibility.enabledModelPatterns.length > 0 &&
		!eligibility.enabledModelPatterns.some((pattern) => matchesSelector(model, pattern))
	) {
		return "not-allowlisted";
	}
	if (eligibility.accepts && !eligibility.accepts(model)) return "kind-ineligible";

	// Free stays free: a free session must not cross into a paid candidate.
	if (eligibility.sessionModel?.free === true && !policyAllowsPaid(eligibility.policy ?? "free-only")) {
		if (model.free !== true) return "policy-paid";
	}

	if (!isCredentialFree(model) && !isAnonymouslyAccessible(model.provider, model.id)) {
		if (eligibility.credentialMissing?.(model.provider) ?? true) return "missing-credential";
	}
	return undefined;
}

/**
 * Whether a model satisfies a selector.
 *
 * Supports an exact `provider/id`, a bare id, a provider-wide `provider/*`, and
 * a leading glob on the qualified id. A bare id also tolerates a `:` tag suffix,
 * so `llama3` matches `llama3:8b`.
 */
function matchesSelector(model: Model<Api>, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) return false;
	if (trimmed === "*") return true;
	if (trimmed.endsWith("/*")) return model.provider === trimmed.slice(0, -2);

	const qualified = `${model.provider}/${model.id}`;
	if (qualified === trimmed) return true;
	if (trimmed.includes("*")) return qualified.startsWith(trimmed.slice(0, trimmed.indexOf("*")));
	return model.id === trimmed || model.id.startsWith(`${trimmed}:`);
}

// --- Preferences -------------------------------------------------------------

/**
 * Soft ranking inputs. These order candidates that are already eligible.
 *
 * Deliberately a separate type from `RoleEligibility` so a future port cannot
 * pass a preference where a constraint belongs, or read a constraint as though it
 * were tunable.
 */
export interface RolePreferences {
	/**
	 * Provider preference order, most preferred first. Providers absent from the
	 * list rank after those present.
	 */
	providerOrder?: readonly string[];
	/**
	 * Model keys the caller has used recently, most recent first, as
	 * `provider/id`. Purely a familiarity hint.
	 */
	usageOrder?: readonly string[];
}

/**
 * Produces a sort key for an eligible candidate.
 *
 * The key is compared ascending, so a lower number ranks higher. Every component
 * is derived from the candidate itself, and none can encode a preference for a
 * model that failed eligibility, because such a model never reaches the comparator.
 */
export function preferenceRank(model: Model<Api>, preferences: RolePreferences): number[] {
	const providerIndex = preferences.providerOrder?.indexOf(model.provider) ?? -1;
	// An unlisted provider sorts after every listed one.
	const providerRank = providerIndex === -1 ? Number.MAX_SAFE_INTEGER : providerIndex;

	const key = `${model.provider}/${model.id}`;
	const usageIndex = preferences.usageOrder?.indexOf(key) ?? -1;
	const usageRank = usageIndex === -1 ? Number.MAX_SAFE_INTEGER : usageIndex;

	// Anonymous access is a tie-break within a tier, never a way to reach an
	// ineligible model: it is applied only to candidates that already passed.
	const anonymousRank = model.access === "anonymous" ? 0 : 1;

	return [providerRank, usageRank, anonymousRank];
}

// --- Chains ------------------------------------------------------------------

/** One proposed candidate: the model, where it came from, and its metadata. */
export interface RoleChainCandidate {
	model: Model<Api>;
	/** The pattern that matched, before any suffix was stripped. */
	pattern: string;
	/**
	 * True when the candidate came from configuration the user wrote, rather than
	 * a built-in priority chain. Lets a caller prefer an explicit choice without
	 * letting it bypass eligibility.
	 */
	explicit: boolean;
	/** True when the candidate came from a configured fallback list. */
	fromFallback: boolean;
	/** Thinking metadata parsed off the selector, if any. */
	thinking: CandidateThinking;
}

export interface RoleChainInput {
	role: ModelRole;
	/** Explicit per-role configuration, e.g. `{ smol: "@tiny, xai/grok-4.5" }`. */
	configured: Readonly<Record<string, string>>;
	/**
	 * Per-role fallback lists. When a role has one, it replaces the built-in
	 * priority chain, so a user can narrow the candidate set deliberately.
	 */
	fallbackChains?: Readonly<Record<string, readonly string[]>>;
	/** Models the runtime currently offers. */
	available: readonly Model<Api>[];
	/** Hard constraints. */
	eligibility?: RoleEligibility;
	/** Soft ranking, applied only after eligibility. */
	preferences?: RolePreferences;
}

export interface RoleChainResult {
	role: ModelRole;
	/** Candidates that passed every hard constraint, in preference order. */
	candidates: RoleChainCandidate[];
	/** Everything removed, with the reason. */
	rejected: RejectedCandidate[];
	/** The selector list the role expanded to, for diagnostics. */
	patterns: string[];
}

/**
 * Builds the ordered candidate list for a role.
 *
 * The procedure is fixed and each stage has one job:
 *
 *   1. expand the role into selector patterns (alias, inheritance, fallback, then
 *      the built-in chain when nothing is configured);
 *   2. split any thinking suffix off each pattern;
 *   3. match patterns against the available models;
 *   4. remove anything that fails a hard constraint, recording why;
 *   5. order the survivors by preference.
 *
 * Stage 5 only ever sees stage 4's output. That ordering is the whole guarantee:
 * a preferred model that was removed in stage 4 has nothing to be ranked against.
 */
export function resolveRoleChain(input: RoleChainInput): RoleChainResult {
	const { role, configured, available } = input;
	const eligibility = input.eligibility ?? {};
	const info = MODEL_ROLES[role];
	const knownRoles = new Set<string>(Object.keys(configured).filter((key) => isModelRole(key)));

	// A configured fallback list replaces the built-in chain rather than extending
	// it. An empty-but-present list therefore means "no fallbacks", not "defaults".
	const configuredFallbacks = input.fallbackChains?.[role];
	const hasFallbacks = configuredFallbacks !== undefined;

	const patterns = hasFallbacks
		? expandFallbackPatterns(configuredFallbacks, configured, knownRoles)
		: expandRolePatterns({ role, configured, knownRoles });

	if (!info.activeInPi) {
		return {
			role,
			candidates: [],
			rejected: [],
			patterns: [],
		};
	}

	const annotated = patterns.map(splitThinkingSuffix);
	const rejected: RejectedCandidate[] = [];
	const candidates: RoleChainCandidate[] = [];
	const seen = new Set<string>();

	for (const { pattern, thinking } of annotated) {
		// A selector that is still role-shaped resolved to no role, so it names no
		// model. Matching it would let a role id collide with a model id.
		if (isRoleAlias(pattern)) continue;
		// The explicit configuration mark drives preference, never eligibility.
		const explicit = hasConfiguredSelector(configured, role, pattern) || hasFallbacks;
		const fromFallback = hasFallbacks && !hasConfiguredSelector(configured, role, pattern);

		for (const model of available) {
			const key = `${model.provider}:${model.id}`;
			if (seen.has(key)) continue;
			if (!matchesSelector(model, pattern)) continue;

			const reason = evaluateEligibility(model, role, eligibility);
			if (reason) {
				rejected.push({ model, reason });
				continue;
			}
			seen.add(key);
			candidates.push({ model, pattern, explicit, fromFallback, thinking });
		}
	}

	// An explicit configuration keeps its position; only implicit candidates move
	// when preferences disagree. That way a user's stated choice is not reordered
	// underneath them by a provider-order hint.
	candidates.sort((a, b) => {
		if (a.explicit !== b.explicit) return Number(b.explicit) - Number(a.explicit);
		if (!input.preferences) return 0;
		const left = preferenceRank(a.model, input.preferences);
		const right = preferenceRank(b.model, input.preferences);
		for (let index = 0; index < left.length; index++) {
			if (left[index] !== right[index]) return left[index] - right[index];
		}
		return 0;
	});

	return { role, candidates, rejected, patterns };
}

function hasConfiguredSelector(
	configured: Readonly<Record<string, string>>,
	role: ModelRole,
	pattern: string,
): boolean {
	const own = configured[role];
	if (!own) return false;
	return own
		.split(",")
		.map((part) => splitThinkingSuffix(part.trim()).pattern)
		.includes(pattern);
}

/**
 * Expands a configured fallback list into selectors.
 *
 * The result is used as-is, including when it is empty: a user who configures an
 * empty list has said "no fallbacks", and re-seeding from the built-in chain here
 * would quietly undo that. Only a list that was never configured falls through to
 * the built-in chain, and the caller decides that.
 */
function expandFallbackPatterns(
	fallbacks: readonly string[],
	configured: Readonly<Record<string, string>>,
	knownRoles: ReadonlySet<string>,
): string[] {
	const resolved: string[] = [];
	for (const entry of fallbacks) {
		for (const part of entry.split(",")) {
			const element = part.trim();
			if (!element) continue;
			const { pattern } = splitThinkingSuffix(element);
			if (!isRoleAlias(pattern)) {
				resolved.push(pattern);
				continue;
			}
			// A fallback may name a role, and expansion stays bounded and cycle-safe
			// because it reuses the same expander the primary path uses.
			const aliased = expandRoleAliasTarget(pattern);
			if (!aliased) continue;
			resolved.push(
				...expandRolePatterns({ role: aliased, configured, knownRoles }).map((p) => splitThinkingSuffix(p).pattern),
			);
		}
	}
	return resolved;
}

/**
 * The role a selector names, or undefined when it names none.
 *
 * `*` is OMP's shorthand for the default role. An unrecognised or still
 * alias-shaped selector resolves to undefined so it contributes no candidates
 * rather than falling back to a guess.
 */
function expandRoleAliasTarget(value: string): ModelRole | undefined {
	const trimmed = value.trim();
	if (trimmed === "*") return "default";
	const candidate = trimmed.startsWith("@")
		? trimmed.slice(1)
		: trimmed.startsWith("pi/")
			? trimmed.slice(3)
			: trimmed;
	// A role id is recognised whether or not it is currently configured; the
	// expander decides whether it has anything to contribute.
	return isModelRole(candidate) ? candidate : undefined;
}
