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
		activeInPi: false,
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
