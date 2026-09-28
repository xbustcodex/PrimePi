/**
 * Bank scoping for project-local memory storage.
 *
 * ## Why this exists
 *
 * A memory store that keeps everything in one bank leaks every project's
 * memories into every other project. A store that keys banks on the enclosing
 * git repository fragments them the moment the repository moves. Both failure
 * modes are invisible until a session recalls a fact that was true somewhere
 * else, which is precisely the failure this architecture exists to prevent.
 *
 * ## The stability contract
 *
 * **A project's bank is derived from the absolute project path and nothing
 * else.** Not from the git root, not from a `.git` marker, not from a branch.
 *
 * The reference learned this the hard way. Its earlier derivation resolved the
 * enclosing git root, so adding or removing a `.git` anywhere *above* the
 * working directory repointed the same conversation directory to a different
 * bank and stranded every memory it held. The git lookup was deleted, not
 * patched, and the stranded installs are rescued by a separate path
 * ({@link extendRecallWithLegacyBanks}) precisely so the derivation itself can
 * stay simple.
 *
 * ## Why the bank name carries a hash
 *
 * The human-readable prefix alone is not an identity. Two directories named
 * `api` on different drives must not share a bank, and a sanitised name is lossy
 * enough that collisions are likely rather than theoretical. The suffix is a
 * hash of the absolute path, so identity is exact and the name stays legible.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** Longest bank name the store accepts. */
const MAX_BANK_NAME = 64;

/** The bank every project falls back to when no base name is configured. */
export const DEFAULT_SHARED_BANK = "default";

/**
 * How a session's banks are chosen.
 *
 * `per-project-tagged` exists because the store has no tag-filtered recall. A
 * user who wants a fact written locally but recalled from everywhere gets a
 * project-local write bank and a *union* at recall time, which is a superset
 * of what they asked for. That is the honest trade: the alternative is
 * pretending the store can filter, and it cannot.
 */
export type BankScoping = "global" | "per-project" | "per-project-tagged";

export const BANK_SCOPINGS: readonly BankScoping[] = ["global", "per-project", "per-project-tagged"];

export function isBankScoping(value: string): value is BankScoping {
	return (BANK_SCOPINGS as readonly string[]).includes(value);
}

/** Which banks a session writes to and reads from. */
export interface BankScope {
	/** The configured base name, sanitised, or the default. */
	readonly baseBank: string;
	/** This project's bank. Equals `globalBank` under `global` scoping. */
	readonly bank: string;
	/** The shared bank every project can also read. */
	readonly globalBank: string;
	/** Where new memories are written. */
	readonly retainBank: string;
	/** Where recall reads, in order. The first is the primary. */
	readonly recallBanks: readonly string[];
}

/** A short, stable, non-cryptographic hash of a string. */
function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Clamp a bank name to the store's limit without losing identity.
 *
 * Truncation alone would map two long names onto one bank, which is a silent
 * data leak between projects. Truncating *and* appending a hash of the
 * original keeps distinct names distinct.
 */
export function limitBankName(name: string): string {
	if (name.length <= MAX_BANK_NAME) return name;
	const hash = shortHash(name);
	const prefixLength = Math.max(1, MAX_BANK_NAME - 1 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

/**
 * Reduce arbitrary text to a legal bank name.
 *
 * Returns `undefined` for anything that sanitises to nothing, so the caller
 * can fall back rather than producing an empty bank name that would collide
 * with every other empty one.
 */
export function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

/**
 * The project-identity segment for an absolute project root.
 *
 * `<basename>-<hash of the absolute path>`. Exported because the reference
 * shares this exact derivation with its Sharpshooter store so both subsystems
 * key the same directory identically; two derivations that agreed "usually"
 * would fragment a project's memories across both stores.
 */
export function projectBankSegment(projectRoot: string): string {
	const base = sanitizeBankName(path.basename(projectRoot)) ?? DEFAULT_SHARED_BANK;
	return limitBankName(`${base}-${shortHash(projectRoot)}`);
}

/**
 * Resolve the write and recall banks for a session.
 *
 * `per-project-tagged` writes locally and recalls the union. The reference maps
 * it that way because Mnemopi cannot filter recall by tag; this records the same
 * constraint so the behaviour is not mistaken for a bug here.
 */
export function computeBankScope(configured: string | undefined, cwd: string, scoping: BankScoping): BankScope {
	const globalBank = sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
	// The project bank carries the configured base as its prefix, so a team can
	// keep one installation's banks separate from another's without changing the
	// derivation itself. Composing here rather than inside
	// `projectBankSegment` keeps that function a pure function of the path, which
	// is what makes it shareable with a second subsystem.
	const projectRoot = resolveProjectRoot(cwd);
	const segment = projectBankSegment(projectRoot);
	const project = limitBankName(globalBank === DEFAULT_SHARED_BANK ? segment : `${globalBank}-${segment}`);

	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return { baseBank: globalBank, bank: project, globalBank, retainBank: project, recallBanks: [project] };
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				// When the project bank *is* the global bank, listing it twice would
				// make every recall read the same store twice for no benefit.
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

/**
 * The absolute project path a bank is keyed on.
 *
 * Resolved, and deliberately *not* walked upward looking for a repository
 * marker. That walk is the bug this whole module exists to not reintroduce.
 */
function resolveProjectRoot(cwd: string): string {
	return path.resolve(cwd?.trim() ? cwd : ".");
}
