import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffFiles, discoverRepository, type GitService, parsePorcelainZ } from "../src/core/vcs/git-service.ts";

/**
 * The VCS service, against real repositories.
 *
 * The properties here are git's behaviour, not this module's shape: that
 * discovery is fenced, that reads do not mutate, that a worktree and its parent
 * are distinguishable, and that the mutation methods refuse the operations OMP's
 * equivalents perform.
 */

const GIT_TIMEOUT = 60_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

const norm = (value: string): string => value.replace(/\r\n/g, "\n");

function makeRepo(prefix = "pi-vcs-svc-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.com"], dir);
	git(["config", "user.name", "T"], dir);
	writeFileSync(join(dir, "a.txt"), "one\n");
	git(["add", "a.txt"], dir);
	git(["commit", "-q", "-m", "base"], dir);
	return dir;
}

function serviceFor(dir: string): GitService {
	const service = discoverRepository({ cwd: dir, boundary: dir });
	if (!service) throw new Error(`expected a repository at ${dir}`);
	return service;
}

describe("repository discovery and identity", () => {
	it(
		"discovers the repository from a nested directory",
		() => {
			const repo = makeRepo();
			const nested = join(repo, "src", "deep");
			spawnSync("mkdir", ["-p", nested], { windowsHide: true });

			const service = discoverRepository({ cwd: nested, boundary: repo });
			if (!service) throw new Error("expected a repository");
			expect(service.identity.root).toBe(repo);
			expect(service.identity.isLinkedWorktree).toBe(false);
			expect(service.headSha().sha).toBe(git(["rev-parse", "HEAD"], repo));
			expect(service.currentBranch().branch).toBe("main");
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses a repository that starts above the project boundary",
		() => {
			const repo = makeRepo("pi-vcs-fence-");
			const nested = join(repo, "src");
			spawnSync("mkdir", ["-p", nested], { windowsHide: true });

			// OMP's discovery has no fence at all (`crates/pi-vcs/src/git/mod.rs:170-172`),
			// so a directory inside someone's checkout adopts it. Here the boundary is
			// a parameter, so a caller cannot forget it.
			expect(discoverRepository({ cwd: nested, boundary: repo })).toBeDefined();
			expect(discoverRepository({ cwd: repo, boundary: nested })).toBeUndefined();
		},
		GIT_TIMEOUT,
	);

	it(
		"distinguishes a linked worktree from its parent",
		() => {
			const repo = makeRepo("pi-vcs-wt-");
			const parent = serviceFor(repo);
			const worktree = mkdtempSync(join(tmpdir(), "pi-vcs-wt-child-"));
			dirs.push(worktree);
			git(["worktree", "add", "-q", worktree, "-b", "feature"], repo);
			const child = serviceFor(worktree);

			// The distinction the checkpoint layer depends on: same repository,
			// different checkout.
			expect(child.isSameRepository(parent)).toBe(true);
			expect(child.isSameCheckout(parent)).toBe(false);
			expect(child.identity.isLinkedWorktree).toBe(true);
			expect(child.identity.commonDir).toBe(parent.identity.gitDir);
			expect(parent.listCheckouts().length).toBe(2);
		},
		GIT_TIMEOUT,
	);

	it(
		"does not see a worktree's edits from the parent",
		() => {
			const repo = makeRepo("pi-vcs-iso-");
			const worktree = mkdtempSync(join(tmpdir(), "pi-vcs-iso-child-"));
			dirs.push(worktree);
			git(["worktree", "add", "-q", worktree, "-b", "feature"], repo);
			const child = serviceFor(worktree);

			writeFileSync(join(worktree, "a.txt"), "worktree edit\n");
			expect(child.status().files.some((file) => file.path === "a.txt")).toBe(true);
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("one\n");
		},
		GIT_TIMEOUT,
	);
});

describe("read operations do not mutate", () => {
	it(
		"leaves the repository untouched across status, diff and fingerprint",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
			spawnSync("mkdir", ["-p", join(repo, "newdir")], { windowsHide: true });
			writeFileSync(join(repo, "newdir", "untracked.txt"), "new\n");

			const before = service.stateFingerprint().fingerprint;
			const status = service.status();
			expect(status.files.some((file) => file.path === "a.txt" && file.unstaged === "modified")).toBe(true);
			expect(status.files.some((file) => file.path === "newdir/untracked.txt" && file.staged === "untracked")).toBe(
				true,
			);
			expect(status.summary.unstaged).toBe(1);
			expect(status.summary.untracked).toBe(1);

			const diff = service.diff();
			expect(diff.text).toContain("+two");
			expect(diff.files).toContain("a.txt");
			expect(diff.truncated).toBe(false);

			// Three observations changed nothing, and staged nothing.
			expect(service.stateFingerprint().fingerprint).toBe(before);
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("one\ntwo\n");
			expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
		},
		GIT_TIMEOUT,
	);

	it(
		"separates the staged diff from the working-tree diff",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "staged change\n");
			service.stagePaths(["a.txt"]);

			expect(service.diff({ staged: true }).text).toContain("+staged change");
			expect(service.diff().text.trim()).toBe("");
		},
		GIT_TIMEOUT,
	);

	it(
		"limits a diff to the paths named",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
			spawnSync("mkdir", ["-p", join(repo, "dir")], { windowsHide: true });
			writeFileSync(join(repo, "dir", "other.txt"), "other\n");

			const scoped = service.diff({ paths: ["a.txt"] });
			expect(scoped.files).toEqual(["a.txt"]);
			// A path that matches nothing is an empty result, not an error.
			expect(service.diff({ paths: ["nope.txt"] }).ok).toBe(true);
		},
		GIT_TIMEOUT,
	);
});

describe("mutation methods refuse the dangerous shapes", () => {
	it(
		"refuses an empty staging selection",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "edit\n");

			// The only way an empty list could mean something useful is "everything",
			// and everything is exactly what must never be implicit. OMP's
			// `stageFiles([])` is `git add -A` by its own documentation.
			const result = service.stagePaths([]);
			expect(result.ok).toBe(false);
			expect(result.stderr).toMatch(/stage-everything/);
			expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses an empty message and an empty restore",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			expect(service.commit("   ").ok).toBe(false);
			expect(service.commit("   ").stderr).toMatch(/empty message/);
			expect(service.restorePathsFromHead([]).ok).toBe(false);
			expect(service.removeUntrackedPaths([]).ok).toBe(false);
		},
		GIT_TIMEOUT,
	);

	it(
		"stages only the named paths, never the untracked set",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "intended\n");
			writeFileSync(join(repo, "untracked.txt"), "untracked\n");

			expect(service.stagePaths(["a.txt"]).ok).toBe(true);
			expect(git(["diff", "--cached", "--name-only"], repo)).toBe("a.txt");
			expect(git(["ls-files", "--others", "--exclude-standard"], repo)).toBe("untracked.txt");
		},
		GIT_TIMEOUT,
	);

	it(
		"returns the created commit's sha rather than git's summary text",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			writeFileSync(join(repo, "a.txt"), "two\n");
			service.stagePaths(["a.txt"]);

			const commit = service.commit("feat: add a second line\n\nBody.");
			expect(commit.ok).toBe(true);
			// `git commit` prints a human summary, so the SHA is read from HEAD
			// afterwards. OMP discards it entirely
			// (`oh-my-pi/packages/coding-agent/src/commit/agentic/index.ts:249`).
			expect(commit.sha).toBe(git(["rev-parse", "HEAD"], repo));
			const inCommit = git(["show", "--name-only", "--format=", commit.sha as string], repo)
				.split("\n")
				.filter(Boolean);
			expect(inCommit).toEqual(["a.txt"]);
		},
		GIT_TIMEOUT,
	);
});

describe("failure is typed", () => {
	it(
		"reports a missing repository and an unborn branch without throwing",
		() => {
			const plain = mkdtempSync(join(tmpdir(), "pi-vcs-norepo-"));
			dirs.push(plain);
			expect(discoverRepository({ cwd: plain })).toBeUndefined();

			const unborn = mkdtempSync(join(tmpdir(), "pi-vcs-unborn-"));
			dirs.push(unborn);
			git(["init", "-q", "-b", "main"], unborn);
			const service = serviceFor(unborn);
			// A repository with no commits is a real state, not a failure.
			expect(service.headSha().sha).toBeUndefined();
			expect(service.commit("chore: nothing")?.ok).toBe(false);
		},
		GIT_TIMEOUT,
	);

	it(
		"reports an unknown revision with a code",
		() => {
			const repo = makeRepo();
			const service = serviceFor(repo);
			const result = service.showCommit("0000000000000000000000000000000000000000");
			expect(result.ok).toBe(false);
			expect(typeof result.code).toBe("string");
		},
		GIT_TIMEOUT,
	);
});

describe("porcelain parsing", () => {
	it(
		"reads staged, unstaged and untracked states",
		() => {
			const files = parsePorcelainZ("M  a.txt\0 M b.txt\0?? c.txt\0MM d.txt\0");
			const byPath = new Map(files.map((file) => [file.path, file]));
			expect(byPath.get("a.txt")?.staged).toBe("modified");
			expect(byPath.get("a.txt")?.unstaged).toBe("unmodified");
			expect(byPath.get("b.txt")?.staged).toBe("unmodified");
			expect(byPath.get("b.txt")?.unstaged).toBe("modified");
			expect(byPath.get("c.txt")?.staged).toBe("untracked");
			expect(byPath.get("d.txt")?.worktreeOnly).toBe(false);
		},
		GIT_TIMEOUT,
	);

	it(
		"consumes the origin token of a rename rather than reading it as a change",
		() => {
			// In `-z` form a rename is two tokens; reading the origin as a second file
			// would report a deletion the repository never made.
			const files = parsePorcelainZ("R  new.txt\0old.txt\0");
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("new.txt");
			expect(files[0].staged).toBe("renamed");
		},
		GIT_TIMEOUT,
	);

	it(
		"extracts changed paths from a patch",
		() => {
			expect(diffFiles("--- a/x\n+++ b/x\n@@\n-a\n+b\n")).toEqual(["x"]);
			expect(diffFiles("--- /dev/null\n+++ b/new\n")).toEqual(["new"]);
		},
		GIT_TIMEOUT,
	);
});
