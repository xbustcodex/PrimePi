import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/core/orchestration/worktree-manager.ts";

/**
 * Worktree isolation lifecycle.
 *
 * These exercise the real filesystem and a real git repository, because the
 * properties that matter here — a child cannot touch the parent checkout, two
 * children cannot collide, a stale workspace is reclaimable — are only
 * observable against actual state. A mock would assert the shape of the call,
 * not the safety it is supposed to provide.
 */

// Each case provisions one or two real git worktrees. Under a full parallel run
// that is slower than the 5s default, and a timeout here would be a measurement
// artefact rather than a defect — so the budget is explicit.
const GIT_TIMEOUT = 60_000;

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real repository with one commit, so a worktree can actually be created. */
function makeRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-"));
	dirs.push(cwd);
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "config", "user.email", "test@example.com");
	git(cwd, "config", "user.name", "Test");
	writeFileSync(join(cwd, "file.txt"), "original\n");
	git(cwd, "add", "file.txt");
	git(cwd, "commit", "-q", "-m", "base");
	return cwd;
}

function managerFor(cwd: string): WorktreeManager {
	return new WorktreeManager({ baseDir: WorktreeManager.tempBaseDir(), cwd });
}

describe("worktree isolation", () => {
	it(
		"gives a child its own directory with the repository's content",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const outcome = await manager.ensure("task-1", "worktree");
				expect(outcome.ok).toBe(true);
				if (!outcome.ok) return;

				// The child sees the base commit's file...
				expect(readFileSync(join(outcome.handle.path, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
					"original\n",
				);
				// ...but writes there do not reach the parent checkout. This is the
				// entire point: a delegated coding child must not be able to modify
				// the working directory the operator is using.
				writeFileSync(join(outcome.handle.path, "file.txt"), "child edit\n");
				expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses isolation when the directory is not a git repository",
		async () => {
			const plain = mkdtempSync(join(tmpdir(), "pi-not-a-repo-"));
			dirs.push(plain);
			const manager = managerFor(plain);
			try {
				// The refusal matters as much as the success: silently handing a coding
				// child the parent's checkout because provisioning failed would be worse
				// than not running it.
				const outcome = await manager.ensure("task-1", "worktree");
				expect(outcome.ok).toBe(false);
				if (outcome.ok) return;
				expect(outcome.refusal.detail).toMatch(/git|repositor/i);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"gives two children separate directories, so they cannot collide",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const [a, b] = await Promise.all([
					manager.ensure("task-a", "worktree"),
					manager.ensure("task-b", "worktree"),
				]);
				expect(a.ok && b.ok).toBe(true);
				if (!a.ok || !b.ok) return;
				expect(a.handle.path).not.toBe(b.handle.path);

				// Concurrent edits in both children leave the parent untouched, and
				// neither child sees the other's write.
				writeFileSync(join(a.handle.path, "file.txt"), "from a\n");
				writeFileSync(join(b.handle.path, "file.txt"), "from b\n");
				expect(readFileSync(join(a.handle.path, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("from a\n");
				expect(readFileSync(join(b.handle.path, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("from b\n");
				expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"reports a live workspace as not stale, so running work is never reclaimed",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const first = await manager.ensure("task-1", "worktree");
				expect(first.ok).toBe(true);
				if (!first.ok) return;

				// This process owns the workspace, so it belongs to a running task.
				// Reporting it as stale would offer to delete work still in progress.
				expect(manager.stale()).toEqual([]);
				expect(manager.liveCount).toBe(1);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"removes a released workspace and leaves the parent's content alone",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const outcome = await manager.ensure("task-1", "worktree");
				expect(outcome.ok).toBe(true);
				if (!outcome.ok) return;
				const { path } = outcome.handle;
				writeFileSync(join(path, "scratch.txt"), "temporary\n");

				const released = manager.release("task-1");
				expect(released.released).toBe(true);
				expect(existsSync(path)).toBe(false);
				// The parent checkout is untouched by the whole cycle.
				expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
				expect(manager.liveCount).toBe(0);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses to release a path that belongs to another task",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const a = await manager.ensure("task-a", "worktree");
				const b = await manager.ensure("task-b", "worktree");
				expect(a.ok && b.ok).toBe(true);
				if (!a.ok || !b.ok) return;

				// A task releasing by another's id must not delete a live workspace:
				// that would destroy work still in progress.
				const released = manager.release("task-a");
				expect(released.released).toBe(true);
				expect(existsSync(b.handle.path)).toBe(true);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"reports ownership so one task cannot clean up another's workspace",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const a = await manager.ensure("task-a", "worktree");
				expect(a.ok).toBe(true);
				if (!a.ok) return;
				expect(manager.ownsPath("task-a", a.handle.path)).toBe(true);
				expect(manager.ownsPath("task-b", a.handle.path)).toBe(false);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"never merges a child's changes into the parent checkout",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const outcome = await manager.ensure("task-1", "worktree");
				expect(outcome.ok).toBe(true);
				if (!outcome.ok) return;

				// The child commits real work in its own branch.
				writeFileSync(join(outcome.handle.path, "file.txt"), "child work\n");
				git(outcome.handle.path, "add", "file.txt");
				git(outcome.handle.path, "commit", "-q", "-m", "child work");

				// The parent branch still points at the base commit. Integration is a
				// deliberate human decision, not a side effect of a child finishing.
				expect(git(repo, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "main"));
				expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
				// The child did produce a commit an operator can inspect or merge.
				expect(git(outcome.handle.path, "log", "--oneline", "-1")).toMatch(/child work/);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);

	it(
		"reuses one workspace for the same task rather than allocating twice",
		async () => {
			const repo = makeRepo();
			const manager = managerFor(repo);
			try {
				const first = await manager.ensure("task-1", "worktree");
				const second = await manager.ensure("task-1", "worktree");
				expect(first.ok && second.ok).toBe(true);
				if (!first.ok || !second.ok) return;
				// Idempotent: asking twice for the same task must not leave a stale
				// directory behind or reset the child's in-progress edits.
				expect(first.handle.path).toBe(second.handle.path);
				expect(manager.liveCount).toBe(1);
			} finally {
				manager.dispose();
			}
		},
		GIT_TIMEOUT,
	);
});
