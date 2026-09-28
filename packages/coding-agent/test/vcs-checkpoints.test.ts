/**
 * Checkpoints, against real repositories.
 *
 * The properties defended here are properties of git: that a restore cannot cross a
 * worktree, that it cannot silently destroy work done since the checkpoint, and
 * that a create mutates nothing at all. A mock would test the shape of the call
 * rather than the safety.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Checkpoint, CheckpointStore } from "../src/core/vcs/checkpoint-store.ts";
import { discoverRepository, type GitService, isWithin } from "../src/core/vcs/git-service.ts";

/**
 * Checkpoints and the commit pipeline, against real repositories.
 *
 * Everything here asserts on the repository's actual state after the call.
 * The properties being defended — that a restore cannot cross a worktree, that
 * a commit contains only what was named, that a failed step leaves no history —
 * are properties of git's behaviour, so a mock would test the shape of the call
 * rather than the safety.
 */

const GIT_TIMEOUT = 60_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** Git normalises line endings on checkout, so comparisons are normalised. */
const norm = (value: string): string => value.replace(/\r\n/g, "\n");

function makeRepo(prefix = "pi-vcs-ck"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.com"], dir);
	git(["config", "user.name", "T"], dir);
	writeFileSync(join(dir, "a.txt"), "one\n");
	writeFileSync(join(dir, "b.txt"), "untouched\n");
	git(["add", "."], dir);
	git(["commit", "-q", "-m", "base"], dir);
	return dir;
}

function serviceFor(dir: string): GitService {
	const service = discoverRepository({ cwd: dir, boundary: dir });
	if (!service) throw new Error(`expected a repository at ${dir}`);
	return service;
}

/** A `Checkpoint` has no `ok` discriminant, so narrowing is on the presence of an id. */
const isCheckpoint = (value: unknown): value is Checkpoint =>
	typeof value === "object" && value !== null && "id" in value;

describe("checkpoints", () => {
	it(
		"records state without changing the repository",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "agent edit\n");

			const store = new CheckpointStore(service);
			const checkpoint = store.create({ label: "before", origin: "agent", actor: "test" });
			expect(isCheckpoint(checkpoint)).toBe(true);
			if (!isCheckpoint(checkpoint)) return;
			expect(checkpoint.paths).toContain("a.txt");

			// Creation is observably free: nothing staged, nothing committed, and the
			// working tree is exactly as it was.
			expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
			expect(git(["log", "--oneline"], repo).split("\n")).toHaveLength(1);
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("agent edit\n");
		},
		GIT_TIMEOUT,
	);

	it(
		"restores a recorded path and leaves the rest alone",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "agent edit\n");
			const store = new CheckpointStore(service);
			const checkpoint = store.create({ label: "before", origin: "agent", actor: "test" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");

			const result = store.restore(checkpoint.id);
			expect(result.ok).toBe(true);
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("one\n");
			expect(norm(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("untouched\n");
			expect(git(["log", "--oneline"], repo).split("\n")).toHaveLength(1);
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses to restore over unrelated work done since",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "agent edit\n");
			const store = new CheckpointStore(service);
			const checkpoint = store.create({ label: "before", origin: "agent", actor: "test" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");

			// The user edits a file the checkpoint never recorded.
			writeFileSync(join(repo, "b.txt"), "USER WAS EDITING THIS\n");
			const result = store.restore(checkpoint.id);

			// A restore must not be a licence to destroy work. The refusal is the
			// point; the user's bytes surviving is the proof.
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("external-modification");
			expect(result.paths).toContain("b.txt");
			expect(norm(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("USER WAS EDITING THIS\n");
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("agent edit\n");
		},
		GIT_TIMEOUT,
	);

	it(
		"is still path-limited when forced",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "agent edit\n");
			const store = new CheckpointStore(service);
			const checkpoint = store.create({ label: "before", origin: "agent", actor: "test" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");
			writeFileSync(join(repo, "b.txt"), "USER WAS EDITING THIS\n");

			expect(store.restore(checkpoint.id, { force: true }).ok).toBe(true);
			// Force waives the safety check. It does not widen the blast radius: only
			// the checkpoint's own recorded paths are touched.
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("one\n");
			expect(norm(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("USER WAS EDITING THIS\n");
		},
		GIT_TIMEOUT,
	);

	it(
		"removes an untracked file the checkpoint recorded",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "scratch.txt"), "temporary\n");
			const store = new CheckpointStore(service);
			const checkpoint = store.create({ label: "with scratch", origin: "agent", actor: "test" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");
			expect(checkpoint.paths).toContain("scratch.txt");

			const result = store.restore(checkpoint.id);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.removed).toContain("scratch.txt");
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses to restore a checkpoint in another worktree",
		() => {
			const repo = makeRepo();
			const parent = serviceFor(repo);
			const worktree = mkdtempSync(join(tmpdir(), "pi-vcs-ck-wt-"));
			dirs.push(worktree);
			git(["worktree", "add", "-q", worktree, "-b", "feature"], repo);
			const child = serviceFor(worktree);

			// Same repository, different checkout: exactly the distinction the
			// identity key exists to express.
			expect(child.isSameRepository(parent)).toBe(true);
			expect(child.isSameCheckout(parent)).toBe(false);

			writeFileSync(join(repo, "a.txt"), "parent edit\n");
			const checkpoint = new CheckpointStore(parent).create({ label: "x", origin: "agent", actor: "t" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");

			const result = new CheckpointStore(child).restoreIn(checkpoint, child);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("different-checkout");
			// The worktree was not touched by the refusal.
			expect(norm(readFileSync(join(worktree, "a.txt"), "utf8"))).toBe("one\n");
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses to restore a checkpoint in another repository",
		() => {
			const first = makeRepo("pi-vcs-ck-a-");
			const second = makeRepo("pi-vcs-ck-b-");
			writeFileSync(join(first, "a.txt"), "edit\n");
			const checkpoint = new CheckpointStore(serviceFor(first)).create({ label: "x", origin: "agent", actor: "t" });
			if (!isCheckpoint(checkpoint)) throw new Error("expected a checkpoint");

			const otherService = serviceFor(second);
			const result = new CheckpointStore(otherService).restoreIn(checkpoint, otherService);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("different-repository");
			expect(norm(readFileSync(join(second, "a.txt"), "utf8"))).toBe("one\n");
		},
		GIT_TIMEOUT,
	);
});

describe("project boundary", () => {
	it(
		"refuses a repository whose root lies above the boundary",
		() => {
			const repo = makeRepo("pi-vcs-boundary-");
			const nested = join(repo, "src", "deep");
			execFileSync("mkdir", ["-p", nested], { windowsHide: true });

			// Adopting it would hand the agent a repository the user never pointed it
			// at, from a directory nested two levels inside their own project.
			expect(discoverRepository({ cwd: nested, boundary: join(repo, "src") })).toBeUndefined();
			// The boundary that contains the root adopts it normally.
			expect(discoverRepository({ cwd: nested, boundary: repo })).toBeDefined();
			expect(isWithin(repo, nested)).toBe(true);
			expect(isWithin(join(repo, "src"), join(repo, "other"))).toBe(false);
		},
		GIT_TIMEOUT,
	);

	it(
		"reports no repository outside one",
		() => {
			const plain = mkdtempSync(join(tmpdir(), "pi-vcs-none-"));
			dirs.push(plain);
			expect(discoverRepository({ cwd: plain })).toBeUndefined();
		},
		GIT_TIMEOUT,
	);
});
