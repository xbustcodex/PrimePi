/**
 * Worktree isolation for a delegated coding child.
 *
 * ## What OMP does, and what this deliberately does not copy
 *
 * OMP's isolation is a two-key opt-in: `task.isolation.enabled` defaults to
 * **false**, and the per-call `isolated` flag only appears in the tool schema when
 * the setting is on. Requesting isolation while the setting is off is a hard
 * preflight error, not a silent downgrade. That is the right default — a
 * read-only research child gains nothing from a worktree, and paying for one on
 * every spawn would be pure cost.
 *
 * OMP also *merges* child changes back into the parent checkout by default
 * (`task.isolation.apply` defaults true), via a stashed cherry-pick under a repo
 * lock. This phase does not do that. Per the brief and for a defensible reason:
 * returning a reference is safe, and an automatic merge can collide with work
 * the user has done since the child started. So a workspace is created, handed to
 * the child, and reported — never integrated.
 *
 * ## The properties that make this safe
 *
 * **Deterministic ownership.** Every workspace is keyed by the task that owns it,
 * and that key is written to disk inside the workspace before any child runs. A
 * cleanup that finds a workspace owned by a *different* live task refuses to
 * touch it, so one task's failure can never delete another's work.
 *
 * **Collision-safe allocation.** The path is a hash of the repository root and
 * the task id, so two concurrent tasks cannot land on the same directory. If the
 * directory already exists and is owned by someone else, allocation fails loudly
 * rather than reusing it.
 *
 * **Explicit lifecycle.** A workspace is created on spawn, reported on completion,
 * and removed only by `release` — which checks ownership first. Nothing sweeps
 * opportunistically, because a sweep cannot know whether a child is still
 * writing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** How a child's workspace relates to the parent's checkout. */
export type IsolationPolicy =
	/** Share the parent workspace. Right for read-only research. */
	| "shared"
	/** A private worktree. Right for a coding child whose changes must not land inline. */
	| "worktree";

/** Why a workspace could not be provided. */
export type IsolationRefusal =
	| { kind: "git-unavailable"; detail: string }
	| { kind: "not-a-repository"; detail: string }
	| { kind: "path-collision"; detail: string; owner: string };

/** A live workspace belonging to one task. */
export interface WorktreeHandle {
	/** The task that owns it. Never changes. */
	taskId: string;
	/** Absolute path to the child's working directory. */
	path: string;
	/** The repository the worktree was cut from. */
	repoRoot: string;
	/** The commit the worktree was created at. */
	baseSha: string;
	createdAt: number;
}

/** Marker written into a workspace so its owner survives a restart. */
const OWNER_FILE = ".pi-worktree-owner.json";

interface OwnerRecord {
	taskId: string;
	pid: number;
	createdAt: number;
}

function git(args: string[], cwd: string, timeoutMs = 10_000): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

/** The repository root for a directory, or undefined when not in one. */
export function findRepoRoot(cwd: string): string | undefined {
	const result = git(["rev-parse", "--show-toplevel"], cwd);
	return result.ok && result.stdout.length > 0 ? resolve(result.stdout) : undefined;
}

/**
 * A deterministic, collision-resistant directory name for a task's workspace.
 *
 * Derived from the repository root *and* the task id, so the same task in the
 * same repo always gets the same directory — which is what makes a leftover
 * workspace recognizable rather than orphaned. The task id keeps two tasks in one
 * repository apart even under a hash collision, because the path is checked
 * against the recorded owner before reuse.
 */
export function worktreePathFor(baseDir: string, repoRoot: string, taskId: string): string {
	const digest = createHash("sha256")
		.update(`${resolve(repoRoot)}\u0000${taskId}`)
		.digest("hex")
		.slice(0, 12);
	return join(baseDir, `wt-${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}-${digest}`);
}

function readOwner(worktreePath: string): OwnerRecord | undefined {
	const file = join(worktreePath, OWNER_FILE);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OwnerRecord>;
		if (typeof parsed.taskId !== "string") return undefined;
		return {
			taskId: parsed.taskId,
			pid: typeof parsed.pid === "number" ? parsed.pid : -1,
			createdAt: parsed.createdAt ?? 0,
		};
	} catch {
		return undefined;
	}
}

/** Whether a process with this id is currently alive. */
function isProcessLive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface WorktreeManagerOptions {
	/** Parent directory that holds all task worktrees. */
	baseDir: string;
	/** The parent session's working directory. */
	cwd: string;
	/**
	 * Whether this manager created `baseDir` and may delete it on dispose.
	 *
	 * Defaults false, so disposing a manager handed a shared directory by a
	 * caller never removes that caller's directory.
	 */
	ownsBaseDir?: boolean;
	now?: () => number;
}

export type IsolationOutcome =
	| { ok: true; handle: WorktreeHandle; policy: IsolationPolicy }
	| { ok: false; policy: IsolationPolicy; refusal: IsolationRefusal };

/**
 * Creates and releases task worktrees for one session.
 *
 * One instance per session, so the in-memory set of live handles and the on-disk
 * owner markers always agree about which workspaces belong to this process.
 */
export class WorktreeManager {
	readonly #baseDir: string;
	readonly #cwd: string;
	readonly #now: () => number;
	/**
	 * Whether this manager created its base directory and may remove it.
	 *
	 * A caller-supplied base directory belongs to the caller, so disposing a
	 * manager must never delete it.
	 */
	readonly #ownsBaseDir: boolean;
	/** Handles this process is actively using, keyed by task id. */
	readonly #live = new Map<string, WorktreeHandle>();

	constructor(options: WorktreeManagerOptions) {
		this.#baseDir = options.baseDir;
		this.#cwd = options.cwd;
		this.#now = options.now ?? Date.now;
		this.#ownsBaseDir = options.ownsBaseDir ?? false;
	}

	/** Workspaces this session currently owns. */
	get liveCount(): number {
		return this.#live.size;
	}

	/** A handle for a task this session owns. */
	get(taskId: string): WorktreeHandle | undefined {
		return this.#live.get(taskId);
	}

	/**
	 * Provides a workspace for a task according to the policy.
	 *
	 * A `shared` policy resolves without touching git, because a research child
	 * needs nothing from a worktree and paying for one would be waste.
	 */
	async ensure(taskId: string, policy: IsolationPolicy): Promise<IsolationOutcome> {
		if (policy === "shared") {
			return {
				ok: true,
				policy,
				handle: { taskId, path: this.#cwd, repoRoot: this.#cwd, baseSha: "", createdAt: this.#now() },
			};
		}

		const existing = this.#live.get(taskId);
		if (existing) return { ok: true, policy, handle: existing };

		const repoRoot = findRepoRoot(this.#cwd);
		if (!repoRoot) {
			return {
				ok: false,
				policy,
				refusal: { kind: "not-a-repository", detail: `No git repository found at ${this.#cwd}.` },
			};
		}

		const head = git(["rev-parse", "HEAD"], repoRoot);
		if (!head.ok) {
			return {
				ok: false,
				policy,
				refusal: { kind: "git-unavailable", detail: head.stderr || "git rev-parse HEAD failed" },
			};
		}

		const worktreePath = worktreePathFor(this.#baseDir, repoRoot, taskId);
		if (existsSync(worktreePath)) {
			// The directory is deterministic, so an existing one is either a
			// leftover from this task or someone else's. Reusing it without
			// checking would let one task inherit another's changes.
			const owner = readOwner(worktreePath);
			if (!owner || owner.taskId !== taskId) {
				return {
					ok: false,
					policy,
					refusal: {
						kind: "path-collision",
						detail: `${worktreePath} is already in use and is not owned by task ${taskId}.`,
						owner: owner?.taskId ?? "unknown",
					},
				};
			}
		} else {
			mkdirSync(this.#baseDir, { recursive: true });
		}

		const branch = `pi/task/${taskId}`;
		const add = git(["worktree", "add", "--detach", worktreePath, head.stdout], repoRoot);
		if (!add.ok) {
			// `--detach` avoids creating a branch the user never asked for, and keeps
			// cleanup to a worktree removal rather than a branch delete.
			const withBranch = git(["worktree", "add", "-b", branch, worktreePath, head.stdout], repoRoot);
			if (!withBranch.ok) {
				return {
					ok: false,
					policy,
					refusal: {
						kind: "git-unavailable",
						detail: withBranch.stderr || add.stderr || "git worktree add failed",
					},
				};
			}
		}

		// The owner marker is written before the child is told to run, so a
		// concurrent cleanup can already tell whose workspace this is.
		writeFileSync(
			join(worktreePath, OWNER_FILE),
			JSON.stringify({ taskId, pid: process.pid, createdAt: this.#now() } satisfies OwnerRecord),
			"utf8",
		);

		const handle: WorktreeHandle = {
			taskId,
			path: worktreePath,
			repoRoot,
			baseSha: head.stdout,
			createdAt: this.#now(),
		};
		this.#live.set(taskId, handle);
		return { ok: true, policy, handle };
	}

	/**
	 * Whether a change to a path is confined to one task's workspace.
	 *
	 * Used by a child's own writes to prove it stayed inside the directory it was
	 * given rather than reaching back into the parent checkout.
	 */
	ownsPath(taskId: string, candidate: string): boolean {
		const handle = this.#live.get(taskId);
		if (!handle) return false;
		const resolved = resolve(candidate);
		return resolved === handle.path || resolved.startsWith(handle.path + sep);
	}

	/**
	 * Releases a task's workspace.
	 *
	 * Ownership is checked first: a workspace whose marker names a different task
	 * is left alone, so one task's cleanup can never remove another's work. A
	 * refusal is reported rather than thrown, because a failed cleanup must not
	 * mask the task result that caused it.
	 */
	release(taskId: string): { released: boolean; detail?: string } {
		const handle = this.#live.get(taskId);
		if (!handle) return { released: false, detail: "No live worktree for this task." };
		if (handle.path === this.#cwd) {
			// A shared policy never created one; nothing to remove.
			this.#live.delete(taskId);
			return { released: true };
		}

		const owner = readOwner(handle.path);
		if (owner && owner.taskId !== taskId) {
			return {
				released: false,
				detail: `Refusing to remove ${handle.path}: it is owned by task ${owner.taskId}.`,
			};
		}

		const repoRoot = handle.repoRoot;
		const remove = git(["worktree", "remove", "--force", handle.path], repoRoot);
		if (!remove.ok) {
			// Fall back to removing the directory directly. `git worktree prune`
			// then clears the administrative entry.
			try {
				rmSync(handle.path, { recursive: true, force: true });
			} catch (error) {
				this.#live.delete(taskId);
				return { released: false, detail: error instanceof Error ? error.message : String(error) };
			}
		}
		git(["worktree", "prune"], repoRoot);
		this.#live.delete(taskId);
		return { released: true };
	}

	/**
	 * Workspaces left behind by a process that died.
	 *
	 * Reported, never deleted. A directory whose owning process is still alive
	 * belongs to a running task; one whose process is gone is a candidate for the
	 * operator to remove, and deciding that automatically would risk discarding
	 * work a child had produced.
	 */
	stale(): { path: string; taskId: string; lastOwnerPid: number }[] {
		const results: { path: string; taskId: string; lastOwnerPid: number }[] = [];
		if (!existsSync(this.#baseDir)) return results;
		for (const entry of require("node:fs").readdirSync(this.#baseDir) as string[]) {
			if (!entry.startsWith("wt-")) continue;
			const path = join(this.#baseDir, entry);
			const owner = readOwner(path);
			if (!owner) continue;
			if (this.#live.has(owner.taskId)) continue;
			if (isProcessLive(owner.pid)) continue;
			results.push({ path, taskId: owner.taskId, lastOwnerPid: owner.pid });
		}
		return results;
	}

	/**
	 * Releases every workspace this manager owns, then removes the base directory
	 * if it created one.
	 *
	 * Called when a session ends. Individual failures are reported rather than
	 * thrown, because a cleanup that throws would mask the session teardown that
	 * called it — and a leaked directory is recoverable, an aborted dispose is
	 * not.
	 */
	dispose(): { released: string[]; failed: { taskId: string; detail: string }[] } {
		const released: string[] = [];
		const failed: { taskId: string; detail: string }[] = [];
		for (const taskId of [...this.#live.keys()]) {
			const outcome = this.release(taskId);
			if (outcome.released) released.push(taskId);
			else failed.push({ taskId, detail: outcome.detail ?? "unknown" });
		}
		if (this.#ownsBaseDir) {
			try {
				rmSync(this.#baseDir, { recursive: true, force: true });
			} catch {
				// The base directory is a temp dir; a locked one is cleaned by the OS.
			}
		}
		return { released, failed };
	}

	/** A scratch directory for a session, created on demand. */
	static tempBaseDir(prefix = "pi-tasks-"): string {
		return mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? ".", prefix));
	}
}
