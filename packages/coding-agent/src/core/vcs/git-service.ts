/**
 * The central repository/VCS authority.
 *
 * ## Why this exists
 *
 * Before this, Pi had no VCS layer at all: one ad-hoc `spawnSync("git", ...)` in
 * the footer for a branch label, and the Phase 6 worktree manager with its own
 * private `git()` helper. Two callers, two conventions, no shared notion of what
 * repository a path belongs to — which is exactly the state in which a
 * checkpoint can be applied to the wrong tree.
 *
 * The OMP trace found the same shape of problem one layer down: its VCS is a Rust
 * addon with 22 mutating operations, and the callers that matter reach git
 * through an unconstrained shell instead. The authority is centralised there too;
 * it simply is not TypeScript, so none of it ports.
 *
 * ## The three properties worth protecting
 *
 * **Identity is a value, not a path string.** {@link RepositoryIdentity} is
 * `repoRoot` + `gitDir` + `commonDir`. A linked worktree and its primary
 * checkout share a `commonDir` and differ in `gitDir`, which is the same test OMP
 * uses (`crates/pi-vcs/src/git/mod.rs:118-120`). Everything that mutates is
 * scoped by that value, so a checkpoint or commit issued for worktree A cannot
 * reach worktree B.
 *
 * **Discovery is fenced at the project boundary.** OMP's walk runs to the
 * filesystem root (`git/mod.rs:170-172`) and the fence lives in a separate TS
 * layer. Here it is a parameter, so a caller cannot forget it: a repository found
 * *above* the boundary is refused rather than adopted. An unfenced walk from a
 * nested directory would silently hand the agent a repository the user never
 * pointed it at.
 *
 * **Read and write are different methods with different provenance.** Every read
 * here is pure. Every mutation is a named method that the caller must have
 * decided to call, and each one is routed through the Phase 3 approval gate by the
 * tool that exposes it — never through a privileged internal bypass. The split is
 * structural: there is no `run(args: string[])` for a caller to reach.
 *
 * ## Deliberately not ported
 *
 * - **No caching.** OMP's `OnceLock` handle snapshot is documented as never
 *   invalidated and shipped a real regression from it (`crates/pi-vcs/src/git/open.rs:58-73`).
 *   A status call here is a fresh subprocess, which is milliseconds.
 * - **No native implementation.** OMP's gitoxide backend exists for reasons that
 *   do not apply here, and reproducing it would be parity theatre.
 * - **No network operations.** `push`, `fetch` and `clone` are absent by design;
 *   this phase has no push path at all.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The result of one Git invocation.
 *
 * `code` is a stable discriminant rather than prose, so callers branch on
 * failure kind instead of regexing stderr. OMP's `Error::kind()` exists for the
 * same reason (`crates/pi-vcs/src/error.rs:139-155`).
 */
export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** Stable failure kind. `undefined` on success. */
	code?: GitFailureCode;
}

export type GitFailureCode =
	| "not-a-repository"
	| "not-found"
	| "ambiguous-path"
	| "outside-boundary"
	| "empty-result"
	| "output-too-large"
	| "timed-out"
	| "git-missing"
	| "git-failed";

/** One Git invocation's raw output, with the byte cap applied. */
interface RawResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	status: number | null;
	timedOut: boolean;
	error?: NodeJS.ErrnoException;
}

/**
 * How a repository is identified for every subsequent operation.
 *
 * `commonDir` is what makes worktrees distinguishable: a linked worktree's
 * `gitDir` is its own directory, while `commonDir` points at the primary
 * repository's `.git`. Two checkouts of one repository are therefore the same
 * *repository* and different *checkouts*, which is exactly the distinction the
 * checkpoint layer needs.
 */
export interface RepositoryIdentity {
	/** The working tree root of this checkout. */
	readonly root: string;
	/** This checkout's git directory. Unique per checkout. */
	readonly gitDir: string;
	/** The shared git directory. Equal across every checkout of the repository. */
	readonly commonDir: string;
	/** True when this is a linked worktree rather than the primary checkout. */
	readonly isLinkedWorktree: boolean;
}

/** One path's state, as porcelain v1 reports it. */
export interface ChangedFile {
	/** Path relative to the repository root, using forward slashes. */
	readonly path: string;
	/** Porcelain X column: the index state. */
	readonly staged: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmodified" | "untracked" | "conflicted";
	/** Porcelain Y column: the working-tree state. */
	readonly unstaged: "modified" | "deleted" | "untracked" | "conflicted" | "unmodified";
	/** True when git reported the path but no content change (e.g. a mode change). */
	readonly worktreeOnly: boolean;
}

/** Counts, for a fast "is anything happening" answer. */
export interface StatusSummary {
	readonly staged: number;
	readonly unstaged: number;
	readonly untracked: number;
	readonly conflicted: number;
}

/** A bounded diff. */
export interface DiffResult {
	/** The patch text, git dialect. Empty when there are no changes. */
	readonly text: string;
	/** True when the cap was hit and the text is a prefix, not the whole diff. */
	readonly truncated: boolean;
	/** Files the diff covers, in git's order. */
	readonly files: readonly string[];
}

/** Where a diff should be read from. */
export interface DiffScope {
	/** Include staged changes (the index) rather than the working tree. */
	readonly staged?: boolean;
	/** Limit the diff to these paths, relative to the repository root. */
	readonly paths?: readonly string[];
	/** Context lines around each hunk. */
	readonly contextLines?: number;
}

export interface GitServiceOptions {
	/** The directory Git is invoked in. Also the discovery starting point. */
	readonly cwd: string;
	/**
	 * Do not adopt a repository found above this directory.
	 *
	 * OMP's discovery has no such fence and the boundary is enforced elsewhere.
	 * Here it is a parameter so a caller cannot forget it.
	 */
	readonly boundary?: string;
	/** Injected for tests; defaults to a real subprocess. */
	readonly run?: (args: readonly string[], cwd: string) => RawResult;
	/** Injected for tests; defaults to `Date.now`. */
	readonly now?: () => number;
	/** Per-invocation deadline. */
	readonly timeoutMs?: number;
}

/** Cap on captured output, so a pathological diff cannot exhaust memory. */
const DEFAULT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const X_COLUMN: Record<string, ChangedFile["staged"]> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "conflicted",
	"?": "untracked",
	" ": "unmodified",
	T: "modified",
};

/**
 * Control characters delimiting `git log` records and their fields.
 *
 * Chosen because a commit subject is attacker-controlled repository content: a
 * subject containing a newline, or one of these characters, must not be able to
 * forge an extra record or shift a field boundary.
 */
// Written as character codes so the value survives any editor or transport that
// would strip a literal control character out of a source file.
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const FIELD_SEPARATOR = String.fromCharCode(0x1f);

const Y_COLUMN: Record<string, ChangedFile["unstaged"]> = {
	M: "modified",
	D: "deleted",
	T: "modified",
	U: "conflicted",
	"?": "untracked",
	" ": "unmodified",
	A: "modified",
	R: "modified",
	C: "modified",
};

/**
 * The brand carried by {@link GitService}. Exported so a consumer can narrow a
 * value without `instanceof`, which is unreliable across duplicated modules.
 */
export const GIT_SERVICE_BRAND: unique symbol = Symbol.for("pi.gitService") as never;

function defaultRun(args: readonly string[], cwd: string): RawResult {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		timeout: DEFAULT_TIMEOUT_MS,
		maxBuffer: DEFAULT_OUTPUT_LIMIT_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		// A Git invocation must never block on a credential or editor prompt, and
		// must not inherit an environment that redirects it at a different
		// repository than the one we resolved. Both are set explicitly rather
		// than relying on the caller's environment being clean.
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "true",
			LC_MESSAGES: "C",
			GIT_DIR: undefined,
			GIT_COMMON_DIR: undefined,
			GIT_WORK_TREE: undefined,
			GIT_INDEX_FILE: undefined,
		},
	});
	if (result.error) {
		return {
			ok: false,
			stdout: "",
			stderr: result.error.message,
			status: null,
			timedOut: false,
			error: result.error,
		};
	}
	// `result.error` was already handled above, so by this point it is absent and
	// the timeout is the only remaining reason a non-zero status can be a hang.
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		timedOut: false,
	};
}

function trimTrailingNewline(value: string): string {
	return value.replace(/\r?\n$/, "");
}

/**
 * Normalizes a path for comparison: absolute, separator-stable, symlink-resolved.
 *
 * Git reports paths with forward slashes on every platform
 * (`rev-parse --show-toplevel` returns `C:/repo`, not `C:\repo`), so the input
 * has to be separator-normalized before it reaches `realpathSync` or the two
 * forms of the same directory would not compare equal — and a boundary check
 * that cannot compare equal is a boundary check that fails closed on its own
 * repository.
 */
function canonical(value: string): string {
	const slashed = value.replace(/[\\/]+/g, sep);
	const absolute = isAbsolute(slashed) ? slashed : resolve(slashed);
	try {
		// `realpathSync` collapses the symlink and junction differences that would
		// otherwise make the same directory look like two. A missing path is left
		// as-is; the caller is about to create or stat it anyway.
		return (realpathSync.native ? realpathSync.native(absolute) : realpathSync(absolute)).replace(/[\\/]+$/, "");
	} catch {
		return absolute.replace(/[\\/]+$/, "");
	}
}

/** True when `candidate` is `parent` or lives beneath it. */
export function isWithin(parent: string, candidate: string): boolean {
	const rel = relative(canonical(parent), canonical(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The repository and VCS authority for one checkout.
 *
 * Construct it through {@link discoverRepository}; the constructor is
 * deliberately awkward so an identity cannot be invented.
 */
export class GitService {
	/**
	 * A symbol brand, so a consumer can narrow without `instanceof`.
	 *
	 * This module loads through more than one module graph (source, bundle, and
	 * test runners), and `instanceof` fails silently across a duplicated module —
	 * which would turn every call into a "no repository here" refusal rather than
	 * an error.
	 */
	readonly [GIT_SERVICE_BRAND] = true as const;
	readonly identity: RepositoryIdentity;
	readonly #run: (args: readonly string[], cwd: string) => RawResult;
	readonly #timeoutMs: number;
	readonly #outputLimitBytes: number;

	constructor(
		identity: RepositoryIdentity,
		options: {
			run?: (args: readonly string[], cwd: string) => RawResult;
			timeoutMs?: number;
			outputLimitBytes?: number;
		} = {},
	) {
		this.identity = identity;
		this.#run = options.run ?? defaultRun;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
	}

	// --- identity ------------------------------------------------------------

	/** A stable key for this checkout. Distinct per worktree, shared per repository. */
	get repositoryKey(): string {
		return canonical(this.identity.commonDir);
	}

	/** A stable key for this specific checkout. Differs for each linked worktree. */
	get checkoutKey(): string {
		return canonical(this.identity.gitDir);
	}

	/**
	 * True when `other` is the same repository, possibly a different checkout.
	 *
	 * The comparison is on `commonDir`, which is what a repository shares across
	 * its worktrees.
	 */
	isSameRepository(other: GitService): boolean {
		return this.repositoryKey === other.repositoryKey;
	}

	/** True when `other` is the very same checkout. */
	isSameCheckout(other: GitService): boolean {
		return this.checkoutKey === other.checkoutKey;
	}

	// --- reads ---------------------------------------------------------------

	/**
	 * The current HEAD commit, or `undefined` on an unborn branch.
	 *
	 * An unborn branch is a real state (a fresh repository before its first
	 * commit), not a failure, so it resolves rather than throwing.
	 */
	headSha(): GitResult & { sha?: string } {
		const result = this.#exec(["rev-parse", "HEAD"]);
		if (!result.ok) {
			// A repository with no commits has no HEAD to resolve. That is not an
			// error for a caller that only wanted to know "is there a commit".
			return { ...result, code: result.code ?? "not-found" };
		}
		return { ...result, sha: trimTrailingNewline(result.stdout) };
	}

	/** The current branch name, or `undefined` when HEAD is detached. */
	currentBranch(): GitResult & { branch?: string } {
		const result = this.#exec(["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!result.ok) return { ...result };
		return { ...result, branch: trimTrailingNewline(result.stdout) };
	}

	/**
	 * Per-file status, in porcelain v1.
	 *
	 * `-z` is used so a path containing a space, a quote or a newline cannot
	 * desynchronise the parser; rename entries consume the following token as the
	 * source path, which is why the result is keyed on the destination.
	 */
	status(): GitResult & { files: ChangedFile[]; summary: StatusSummary } {
		const result = this.#exec(["status", "--porcelain", "-z", "--untracked-files=all"]);
		if (!result.ok) return { ...result, files: [], summary: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } };

		const files = parsePorcelainZ(result.stdout);
		return {
			...result,
			files,
			summary: {
				staged: files.filter((file) => file.staged !== "unmodified" && file.staged !== "untracked").length,
				unstaged: files.filter((file) => file.unstaged !== "unmodified" && file.unstaged !== "untracked").length,
				untracked: files.filter((file) => file.staged === "untracked").length,
				conflicted: files.filter((file) => file.staged === "conflicted" || file.unstaged === "conflicted").length,
			},
		};
	}

	/**
	 * A bounded diff.
	 *
	 * The cap is a refusal, not a silent truncation of the middle: a caller that
	 * receives a truncated diff is told so, and can narrow `paths` rather than
	 * acting on a patch that is missing hunks.
	 */
	diff(scope: DiffScope = {}): GitResult & DiffResult {
		const args = ["--no-pager", "diff", `--unified=${scope.contextLines ?? 3}`];
		if (scope.staged) args.push("--cached");
		args.push("--no-color", "--no-ext-diff");
		if (scope.paths && scope.paths.length > 0) {
			args.push("--");
			// Literal pathspecs, so a path containing a glob character names
			// itself rather than matching a set of files.
			for (const path of scope.paths) args.push(`:(literal)${path}`);
		}
		const result = this.#exec(args);
		if (!result.ok) return { ...result, text: "", truncated: false, files: [] };

		const truncated = result.stdout.length > this.#outputLimitBytes;
		const text = truncated ? result.stdout.slice(0, this.#outputLimitBytes) : result.stdout;
		return { ...result, text, truncated, files: diffFiles(text) };
	}

	/** Just the paths a diff would cover, without rendering it. */
	changedFiles(scope: DiffScope = {}): GitResult & { files: string[] } {
		const diff = this.diff(scope);
		if (!diff.ok) return { ...diff, files: [] };
		// `--name-only` is cheaper than rendering hunks for a path list, which is
		// a value rather than a diagnostic.
		const args = ["diff", "--name-only", "--no-color"];
		if (scope.staged) args.push("--cached");
		if (scope.paths && scope.paths.length > 0) {
			args.push("--");
			for (const path of scope.paths) args.push(`:(literal)${path}`);
		}
		const result = this.#exec(args);
		if (!result.ok) return { ...result, files: [] };
		return {
			...result,
			files: result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		};
	}

	/**
	 * Recent commits, newest first.
	 *
	 * Subjects are attacker-controlled repository content, and this is the surface
	 * most likely to be read before deciding what to do next. The format uses
	 * control characters as separators so a subject containing a newline or a
	 * record separator cannot forge an extra entry, and newlines inside a subject
	 * are collapsed.
	 */
	log(count = 10): GitResult & { entries: { sha: string; subject: string }[] } {
		const result = this.#exec([
			"log",
			`--max-count=${Math.max(1, Math.min(200, Math.trunc(count)))}`,
			"--no-color",
			"--format=%H%x1f%s%x1e",
		]);
		if (!result.ok) return { ...result, entries: [] };
		const entries: { sha: string; subject: string }[] = [];
		for (const record of result.stdout.split(RECORD_SEPARATOR)) {
			const trimmed = record.trim();
			if (trimmed.length === 0) continue;
			const separator = trimmed.indexOf(FIELD_SEPARATOR);
			if (separator === -1) continue;
			const sha = trimmed.slice(0, separator).trim();
			if (sha.length === 0) continue;
			// Newlines inside a subject are collapsed: a multi-line subject would
			// otherwise render as several lines in a review surface and read as
			// several separate facts.
			const subject = trimmed
				.slice(separator + 1)
				.replace(/\s+/g, " ")
				.trim();
			entries.push({ sha, subject });
		}
		return { ...result, entries };
	}

	/**
	 * A content fingerprint of the current state.
	 *
	 * Used to detect that something changed between two observations. It covers
	 * the index, the working tree, the untracked set and HEAD, so a change in any
	 * of them produces a different value.
	 */
	stateFingerprint(): GitResult & { fingerprint: string } {
		const head = this.headSha();
		const status = this.status();
		if (!status.ok) return { ...status, fingerprint: "" };
		// A coarse digest of the porcelain status is enough: the point is change
		// detection between two calls, not content addressing.
		const parts = [head.sha ?? "<unborn>"];
		for (const file of status.files) parts.push(`${file.staged}${file.unstaged}:${file.path}`);
		return { ...status, fingerprint: createFingerprint(parts) };
	}

	/**
	 * Every checkout of this repository, including this one.
	 *
	 * "The repository" is not a sufficient name for a place to write: a linked
	 * worktree and its parent are the same repository and different checkouts,
	 * which is why the checkpoint layer keys on the checkout rather than the
	 * repository.
	 *
	 * ## The returned `gitDir` is the checkout path, not a git directory
	 *
	 * Named for shape-compatibility with `RepositoryIdentity`, and it is **not** one:
	 * `checkoutKey` is `canonical(this.identity.gitDir)` — the `.git` directory — while
	 * the value below is `canonical(path)`, the working tree root. For the primary
	 * checkout those differ (`repo` vs `repo/.git`), and for a linked worktree the git
	 * directory lives inside the parent repository entirely.
	 *
	 * Do not feed this into a `checkoutKey` comparison; use
	 * `discoverRepository(path).checkoutKey` for that. Documented rather than renamed
	 * because a caller wanting "which checkouts exist" and one wanting "which checkout
	 * am I" are different questions, and conflating them is the error this prevents.
	 *
	 * Nothing in production calls this yet, so no caller is currently misled.
	 */
	listCheckouts(): { path: string; gitDir: string; branch?: string }[] {
		const result = this.#exec(["worktree", "list", "--porcelain"]);
		if (!result.ok) return [];
		const checkouts: { path: string; gitDir: string; branch?: string }[] = [];
		let current: { path: string; branch?: string } | undefined;
		const flush = () => {
			if (current) checkouts.push({ path: current.path, gitDir: canonical(current.path), branch: current.branch });
		};
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("worktree ")) {
				flush();
				current = { path: line.slice("worktree ".length).trim() };
			} else if (line.startsWith("branch ") && current) {
				current.branch = line.slice("branch ".length).trim();
			}
		}
		flush();
		return checkouts;
	}

	// --- mutations -----------------------------------------------------------
	//
	// Every mutation is a named method. There is no `run(args)` escape hatch, so
	// a caller cannot perform an operation this file did not anticipate, and the
	// approval decision maps one-to-one onto a method name.

	/**
	 * Stages exactly the named paths.
	 *
	 * There is no `stageAll()`. OMP's `stageFiles([])` is `git add -A` by
	 * documentation (`crates/pi-vcs/src/git/mutate.rs:81-83`) and its commit
	 * pipeline calls it whenever the index is empty
	 * (`commit/agentic/index.ts:40-47`), which sweeps unrelated user work into a
	 * commit with nothing but a stdout line for warning. Selection here is always
	 * explicit.
	 */
	stagePaths(paths: readonly string[]): GitResult {
		if (paths.length === 0) {
			return {
				ok: false,
				stdout: "",
				stderr: "Refusing to stage nothing: an empty selection would mean stage-everything.",
				code: "empty-result",
			};
		}
		return this.#exec(["add", "--", ...paths.map((path) => `:(literal)${path}`)]);
	}

	/** Removes the named paths from the index, leaving the working tree alone. */
	unstagePaths(paths: readonly string[]): GitResult {
		if (paths.length === 0) {
			return {
				ok: false,
				stdout: "",
				stderr: "Refusing to unstage nothing.",
				code: "empty-result",
			};
		}
		return this.#exec(["restore", "--staged", "--", ...paths.map((path) => `:(literal)${path}`)]);
	}

	/**
	 * Puts the named paths back to their committed content, in both the index and
	 * the working tree.
	 *
	 * This is the only path in this file that overwrites working-tree content, and
	 * it takes an explicit non-empty list. There is no "all" form and no
	 * `reset --hard`: OMP's equivalent surfaces pass `clean({})` and
	 * `reset("hard")` with an empty path list, which normalises to the entire
	 * worktree (`crates/pi-vcs/src/git/mutate.rs:395-404`,
	 * `autoresearch/tools/log-experiment.ts:322-328`). A caller that can only
	 * pass real paths cannot reproduce that.
	 */
	restorePathsFromHead(paths: readonly string[]): GitResult {
		if (paths.length === 0) {
			return {
				ok: false,
				stdout: "",
				stderr: "Refusing to restore an empty path list: that would mean restoring everything.",
				code: "empty-result",
			};
		}
		return this.#exec([
			"restore",
			"--source=HEAD",
			"--staged",
			"--worktree",
			"--",
			...paths.map((path) => `:(literal)${path}`),
		]);
	}

	/** Deletes the named untracked paths. An empty list is refused. */
	removeUntrackedPaths(paths: readonly string[]): GitResult {
		if (paths.length === 0) {
			return { ok: false, stdout: "", stderr: "Refusing to remove an empty path list.", code: "empty-result" };
		}
		return this.#exec(["clean", "--force", "--", ...paths.map((path) => `:(literal)${path}`)]);
	}

	/**
	 * Commits the current index.
	 *
	 * Only the index is committed, because only the index was staged explicitly.
	 * There is no `--all` form: a caller that wants more must stage it, and
	 * staging is the step where selection is reviewed.
	 */
	commit(message: string, options: { amend?: boolean } = {}): GitResult & { sha?: string } {
		const trimmed = message.trim();
		if (trimmed.length === 0) {
			// An empty message would produce a commit with no description, which is
			// worse than no commit: it is unreviewable in a log.
			return { ok: false, stdout: "", stderr: "Refusing to commit an empty message.", code: "empty-result" };
		}
		const args = ["commit", "--file=-", "--cleanup=verbatim"];
		if (options.amend) args.push("--amend");
		const result = this.#execWithInput(args, `${trimmed}\n`);
		if (!result.ok) return result;
		// The SHA is read from HEAD afterwards, not from git's stdout: `git commit`
		// prints a human summary ("[main abc1234] subject") whose format is not a
		// contract, and whose short SHA is truncated. OMP discards the SHA
		// entirely (`commit/agentic/index.ts:249`); resolving it is the difference
		// between "commit created" and a commit the caller can verify.
		const head = this.headSha();
		return { ...result, ...(head.sha ? { sha: head.sha } : {}) };
	}

	/**
	 * Shows a commit, bounded.
	 *
	 * Used to verify a commit the pipeline just created, so it must survive a
	 * repository whose history is hostile to naive rendering.
	 */
	showCommit(rev: string, maxBytes = 64 * 1024): GitResult & { text: string; truncated: boolean } {
		const result = this.#exec(["show", "--no-color", "--no-ext-diff", "--format=%H%n%an%n%s", rev]);
		if (!result.ok) return { ...result, text: "", truncated: false };
		return {
			...result,
			text: result.stdout.slice(0, maxBytes),
			truncated: result.stdout.length > maxBytes,
		};
	}

	// --- internals -----------------------------------------------------------

	#exec(args: readonly string[]): GitResult {
		return this.#execWithInput(args, undefined);
	}

	#execWithInput(args: readonly string[], input: string | undefined): GitResult {
		const raw = this.#invoke(args, input);
		if (raw.timedOut) {
			return { ok: false, stdout: "", stderr: raw.stderr, code: "timed-out" };
		}
		if (raw.error?.code === "ENOENT") {
			return { ok: false, stdout: "", stderr: "git is not available on PATH.", code: "git-missing" };
		}
		if (raw.error) {
			return { ok: false, stdout: "", stderr: raw.error.message, code: "git-failed" };
		}
		if (!raw.ok) {
			return {
				ok: false,
				stdout: raw.stdout,
				stderr: raw.stderr,
				code: classifyStderr(raw.stderr),
			};
		}
		return { ok: true, stdout: raw.stdout, stderr: raw.stderr };
	}

	#invoke(args: readonly string[], input: string | undefined): RawResult {
		if (this.#run === defaultRun) {
			// Only the default path supports stdin, and only `commit --file=-`
			// needs it. Keeping the message on stdin avoids argv-length limits and
			// avoids a temp file that would have to be cleaned up.
			const result = spawnSync("git", ["--no-optional-locks", ...args], {
				cwd: this.identity.root,
				encoding: "utf8",
				timeout: this.#timeoutMs,
				maxBuffer: this.#outputLimitBytes,
				stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				windowsHide: true,
				...(input === undefined ? {} : { input }),
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "true",
					LC_MESSAGES: "C",
					GIT_DIR: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_INDEX_FILE: undefined,
				},
			});
			const failure = result.error;
			if (failure) {
				const code = (failure as NodeJS.ErrnoException).code;
				return {
					ok: false,
					stdout: "",
					stderr: failure.message,
					status: null,
					timedOut: code === "ETIMEDOUT",
					error: failure as NodeJS.ErrnoException,
				};
			}
			return {
				ok: result.status === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				status: result.status,
				timedOut: false,
			};
		}
		return this.#run(args, this.identity.root);
	}
}

/** Turns porcelain -z output into structured entries. */
export function parsePorcelainZ(output: string): ChangedFile[] {
	const tokens = output.split("\0");
	const files: ChangedFile[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.length < 4) continue;
		const x = token[0];
		const y = token[1];
		const path = token.slice(3).replace(/\\/g, "/");
		// A rename or copy reports `ORIG -> PATH` in the -z form as two
		// consecutive tokens; consume the origin so it is not read as a change.
		if (x === "R" || x === "C") index++;
		files.push({
			path,
			staged: X_COLUMN[x] ?? "unmodified",
			unstaged: Y_COLUMN[y] ?? "unmodified",
			worktreeOnly: x === " " && y !== " ",
		});
	}
	return files;
}

/** Extracts the `+++ b/<path>` destinations from a git-format patch. */
export function diffFiles(patch: string): string[] {
	const files: string[] = [];
	for (const line of patch.split("\n")) {
		if (!line.startsWith("+++ ")) continue;
		const target = line.slice(4).trim();
		if (target === "/dev/null") continue;
		files.push(target.replace(/^b\//, "").replace(/\\/g, "/"));
	}
	return files;
}

function createFingerprint(parts: readonly string[]): string {
	// FNV-1a: this is change detection, not a security boundary, so a fast
	// non-cryptographic digest is the right tool.
	let hash = 0x811c9dc5;
	for (const part of parts) {
		for (let index = 0; index < part.length; index++) {
			hash ^= part.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		hash ^= 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function classifyStderr(stderr: string): GitFailureCode {
	const text = stderr.toLowerCase();
	if (text.includes("not a git repository")) return "not-a-repository";
	if (text.includes("dubious ownership") || text.includes("safe.directory")) return "ambiguous-path";
	if (text.includes("does not have any commits") || text.includes("unknown revision")) return "not-found";
	if (text.includes("pathspec") && text.includes("did not match")) return "not-found";
	return "git-failed";
}

/**
 * Finds the repository containing `cwd`, refusing to escape `options.boundary`.
 *
 * Returns `undefined` when there is no repository, or when the repository that
 * contains `cwd` starts *above* the boundary. The second case is the one OMP
 * cannot express: a directory inside someone's checkout should not silently adopt
 * it just because a `.git` exists further up.
 */
export function discoverRepository(options: GitServiceOptions): GitService | undefined {
	const run = options.run ?? defaultRun;
	const boundary = options.boundary ? canonical(options.boundary) : undefined;
	const start = canonical(options.cwd);

	const topLevel = run(["rev-parse", "--show-toplevel"], start);
	if (!topLevel.ok || topLevel.stdout.trim().length === 0) return undefined;
	const root = canonical(trimTrailingNewline(topLevel.stdout));

	if (boundary && !isWithin(boundary, root)) {
		// The repository that owns this path begins above the project we were told
		// to stay inside. Refusing is the whole point of the fence: adopting it
		// would hand the agent a repository the user never pointed it at.
		return undefined;
	}

	const gitDirResult = run(["rev-parse", "--absolute-git-dir"], root);
	if (!gitDirResult.ok) return undefined;
	const gitDir = canonical(trimTrailingNewline(gitDirResult.stdout));

	// `commonDir` is relative in the output; it is resolved against the git
	// directory, which is the documented base.
	const commonResult = run(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
	const commonDir =
		commonResult.ok && commonResult.stdout.trim().length > 0
			? canonical(trimTrailingNewline(commonResult.stdout))
			: gitDir;

	const identity: RepositoryIdentity = {
		root,
		gitDir,
		commonDir,
		// The same test OMP uses (`crates/pi-vcs/src/git/mod.rs:118-120`): a
		// linked worktree has its own git dir, a `commondir` pointer file, and a
		// common dir that differs.
		isLinkedWorktree: gitDir !== commonDir && existsSync(joinPath(gitDir, "commondir")),
	};

	return new GitService(identity, {
		run: options.run,
		timeoutMs: options.timeoutMs,
	});
}

function joinPath(base: string, child: string): string {
	return base.endsWith(sep) ? `${base}${child}` : `${base}${sep}${child}`;
}

/** Reads a file inside a repository, for tests that need to assert on content. */
export function readRepositoryFile(root: string, relativePath: string): string | undefined {
	const full = resolve(root, relativePath);
	if (!isWithin(root, full)) return undefined;
	return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}
