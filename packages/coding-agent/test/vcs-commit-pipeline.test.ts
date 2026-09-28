/**
 * The commit pipeline, against real repositories.
 *
 * Each case asserts on the repository after the call, not on the returned error. A
 * pipeline that reported a refusal and committed anyway would pass a message check
 * and fail these.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommitPipeline } from "../src/core/vcs/commit-pipeline.ts";
import { discoverRepository, type GitService } from "../src/core/vcs/git-service.ts";

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

describe("commit pipeline", () => {
	function setup() {
		const repo = makeRepo("pi-vcs-commit-");
		const service = serviceFor(repo);
		writeFileSync(join(repo, "a.txt"), "intended change\n");
		// Pre-existing, unrelated, and uncommitted: the work that must survive.
		writeFileSync(join(repo, "b.txt"), "unrelated pre-existing edit\n");
		writeFileSync(join(repo, "brand-new.txt"), "untracked\n");
		return { repo, service };
	}

	it(
		"commits only the named paths",
		async () => {
			const { repo, service } = setup();
			const pipeline = new CommitPipeline({ service, approve: async () => true });

			const result = await pipeline.run({ paths: ["a.txt"], message: "feat: intended change only" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const committed = git(["show", "--name-only", "--format=", result.sha], repo).split("\n").filter(Boolean);
			expect(committed).toEqual(["a.txt"]);
			// The unrelated edit and the untracked file are still exactly where they were.
			expect(norm(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("unrelated pre-existing edit\n");
			expect(git(["diff", "--name-only"], repo)).toContain("b.txt");
			expect(git(["ls-files", "--others", "--exclude-standard"], repo)).toBe("brand-new.txt");
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses an empty selection rather than treating it as everything",
		async () => {
			const { repo, service } = setup();
			const pipeline = new CommitPipeline({ service, approve: async () => true });

			const result = await pipeline.plan({ message: "chore: nothing selected" });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			// The refusal says why, because "no paths named" and "you asked for
			// everything" are very different intents.
			expect(result.reason).toMatch(/stage-everything/);
			expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
		},
		GIT_TIMEOUT,
	);

	it(
		"commits nothing when approval is refused",
		async () => {
			const { repo, service } = setup();
			const head = git(["rev-parse", "HEAD"], repo);
			const pipeline = new CommitPipeline({ service, approve: async () => false });

			const result = await pipeline.run({ paths: ["a.txt"], message: "feat: denied" });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("approval-refused");
			expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
			expect(git(["log", "--oneline"], repo).split("\n")).toHaveLength(1);
		},
		GIT_TIMEOUT,
	);

	it(
		"fails closed when no approval surface exists",
		async () => {
			const { repo, service } = setup();
			const head = git(["rev-parse", "HEAD"], repo);
			const result = await new CommitPipeline({ service }).run({ paths: ["a.txt"], message: "feat: no surface" });

			// Absence of a decision is not a decision. Silently committing here would
			// mean a host that forgot to wire approval got commits.
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("approval-refused");
			expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
		},
		GIT_TIMEOUT,
	);

	it(
		"makes no commit when message generation yields nothing",
		async () => {
			const { repo, service } = setup();
			const head = git(["rev-parse", "HEAD"], repo);
			const pipeline = new CommitPipeline({
				service,
				generateMessage: async () => undefined,
				approve: async () => true,
			});

			const result = await pipeline.run({ paths: ["a.txt"], generateMessage: true });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("message-unavailable");
			// The reason is explicit that nothing was committed, so the caller does
			// not have to infer it from a missing HEAD movement.
			expect(result.reason).toMatch(/Nothing was committed/);
			expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
		},
		GIT_TIMEOUT,
	);

	it(
		"refuses a blank generated message",
		async () => {
			const { repo, service } = setup();
			const head = git(["rev-parse", "HEAD"], repo);
			const pipeline = new CommitPipeline({
				service,
				// OMP commits a file-extension placeholder here; a blank message is the
				// milder version of the same defect and is refused too.
				generateMessage: async () => ({ message: "   " }),
				approve: async () => true,
			});

			expect((await pipeline.run({ paths: ["a.txt"], generateMessage: true })).ok).toBe(false);
			expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
		},
		GIT_TIMEOUT,
	);

	it(
		"makes no commit when validation fails, and leaves the work recoverable",
		async () => {
			const { repo, service } = setup();
			const head = git(["rev-parse", "HEAD"], repo);
			const pipeline = new CommitPipeline({
				service,
				validate: async () => ["the subject is too long", "no tests were run"],
				approve: async () => true,
			});

			const result = await pipeline.run({ paths: ["a.txt"], message: "feat: blocked" });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("validation-failed");
			expect(result.reason).toContain("too long");
			expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
			// The change is still in the tree and still staged: visible, and
			// reversible by hand. A silent rollback would be its own surprise.
			expect(norm(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("intended change\n");
			expect(git(["diff", "--cached", "--name-only"], repo)).toContain("a.txt");
		},
		GIT_TIMEOUT,
	);

	it(
		"reports the generated message as data with its provenance",
		async () => {
			const { service } = setup();
			const pipeline = new CommitPipeline({
				service,
				generateMessage: async () => ({
					message: "feat: generated",
					model: { provider: "openrouter", id: "vendor/free" } as never,
				}),
				approve: async () => true,
			});

			const plan = await pipeline.plan({ paths: ["a.txt"], generateMessage: true });
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			// The model proposed; the approver decides. The plan says which it was.
			expect(plan.plan.messageIsModelGenerated).toBe(true);
			expect(plan.plan.messageModel).toContain("vendor/free");
		},
		GIT_TIMEOUT,
	);
});
