import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeBankScope,
	limitBankName,
	projectBankSegment,
	sanitizeBankName,
} from "../src/core/memory/bank-scope.ts";
import { BankStoreBackend, extendRecallWithLegacyBanks } from "../src/core/memory/bank-store.ts";

/**
 * Project-scoped memory storage.
 *
 * The first three tests are the reference's own regression cases, transcribed
 * from `oh-my-pi/packages/coding-agent/test/mnemopi-bank-derivation.test.ts`.
 * They are not new assertions invented here: each states a failure the reference
 * actually had, so passing them is evidence of matching real behaviour rather
 * than of agreeing with a fresh guess.
 */

describe("bank identity is stable, and the reason matters", () => {
	// Reference regression (#2412). The earlier derivation resolved the enclosing
	// git root, so planting a `.git` marker *above* the working directory
	// repointed the same conversation directory at a different bank and stranded
	// every memory it held. The test plants the marker and proves the bank does
	// not move.
	it("returns the same bank for one directory regardless of git state", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "bank-stable-"));
		const project = path.join(base, "projects", "omp-workstation");
		await mkdir(project, { recursive: true });

		const withoutGit = computeBankScope(undefined, project, "per-project").bank;

		// Plant an ancestor `.git` marker. A git-root-resolving implementation
		// resolves `project` to `base/projects` and produces a different bank.
		await writeFile(path.join(base, "projects", ".git"), "gitdir: /dev/null\n", "utf8");
		const withAncestorGit = computeBankScope(undefined, project, "per-project").bank;
		expect(withAncestorGit).toBe(withoutGit);

		// And removing it must not move it either.
		await writeFile(path.join(base, "projects", ".git"), "", "utf8");
		expect(computeBankScope(undefined, project, "per-project").bank).toBe(withoutGit);
	});

	it("derives different banks for different directories", () => {
		const a = computeBankScope(undefined, path.resolve("/projects/repo-a"), "per-project").bank;
		const b = computeBankScope(undefined, path.resolve("/projects/repo-b"), "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("distinguishes same-named directories on different roots", () => {
		// The reason the bank name carries a hash. A sanitised basename alone maps
		// both of these to `api`, which would leak one project's facts into the other.
		const here = computeBankScope(undefined, path.resolve("C:/work/api"), "per-project").bank;
		const there = computeBankScope(undefined, path.resolve("D:/work/api"), "per-project").bank;
		expect(here).not.toBe(there);
	});
});

describe("scoping modes", () => {
	it("per-project-tagged writes locally and recalls the union", () => {
		const scope = computeBankScope(undefined, path.resolve("/projects/repo"), "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the directory entirely", () => {
		const here = computeBankScope(undefined, path.resolve("/projects/here"), "global");
		const there = computeBankScope(undefined, path.resolve("/elsewhere"), "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});

	it("does not list the same bank twice when the project *is* the shared bank", () => {
		// A configured base that sanitises to "default" makes the two banks equal.
		// Listing it twice makes every recall read the same store twice for nothing.
		const scope = computeBankScope("default", path.resolve("/projects/repo"), "per-project-tagged");
		const unique = new Set(scope.recallBanks);
		expect(unique.size).toBe(scope.recallBanks.length);
	});

	it("prefixes a configured base onto the project segment", () => {
		const scope = computeBankScope("team", path.resolve("/projects/repo"), "per-project");
		expect(scope.bank.startsWith("team-")).toBe(true);
		expect(scope.globalBank).toBe("team");
	});
});

describe("name sanitisation and limits", () => {
	it("strips illegal characters and reports nothing for empty input", () => {
		expect(sanitizeBankName("my bank!")).toBe("my-bank");
		expect(sanitizeBankName("  ")).toBeUndefined();
		expect(sanitizeBankName(undefined)).toBeUndefined();
		// Everything illegal sanitises to nothing, which must fall back rather than
		// produce an empty bank name that collides with every other empty one.
		expect(sanitizeBankName("!!!")).toBeUndefined();
	});

	it("keeps truncated names distinct instead of colliding", () => {
		const a = limitBankName("x".repeat(60) + "-aaaa");
		const b = limitBankName("x".repeat(60) + "-bbbb");
		expect(a).not.toBe(b);
		expect(a.length).toBeLessThanOrEqual(64);
	});

	it("segments are stable and legible", () => {
		const root = path.resolve("C:/work/new_ai");
		const first = projectBankSegment(root);
		expect(projectBankSegment(root)).toBe(first);
		expect(first.startsWith("new_ai-")).toBe(true);
	});
});

describe("the legacy bank rescue refuses to widen recall speculatively", () => {
	it("adds a bank only when every row belongs to the active directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-rescue-"));
		const active = path.join(root, "projects", "myrepo");
		await makeBank(root, "legacy-A", [active]);
		await makeBank(root, "unrelated-B", [path.join(root, "other", "place")]);

		const extended = extendRecallWithLegacyBanks(["active-bank"], root, active);
		// The stranded bank is rescued...
		expect(extended).toContain("legacy-A");
		// ...and another project's is not. Reading it would leak its rows here.
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips a bank holding rows from more than one directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-mixed-"));
		const active = path.join(root, "projects", "myrepo");
		const sibling = path.join(root, "projects", "sibling");
		await makeBank(root, "mixed", [active, sibling]);

		// The store cannot filter rows by project, so a partially-read mixed bank
		// would leak. Refusing it whole is the only choice that cannot leak.
		expect(extendRecallWithLegacyBanks(["active"], root, active)).not.toContain("mixed");
	});

	it("ignores an empty bank, which proves nothing", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-empty-"));
		await makeBank(root, "empty", []);
		// Admitting empty banks would let the rescue grow the recall set forever.
		expect(extendRecallWithLegacyBanks(["active"], root, path.join(root, "p"))).not.toContain("empty");
	});

	it("does not create a bank while probing for one", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-nocreate-"));
		const active = path.join(root, "p");
		await mkdir(path.join(root, "banks", "probe-me"), { recursive: true });
		extendRecallWithLegacyBanks([], root, active);
		// Opening a SQLite database that does not exist creates it. A rescue pass
		// must never bring banks into existence.
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(root, "banks", "probe-me", "bank.db"))).toBe(false);
	});

	it("returns the resolved set unchanged when there is no banks directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-none-"));
		expect(extendRecallWithLegacyBanks(["a"], root, path.join(root, "p"))).toEqual(["a"]);
	});
});

describe("the backend keeps one project's facts out of another's recall", () => {
	it("stores, recalls, and does not leak across projects", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-store-"));
		const alpha = path.join(root, "alpha");
		const beta = path.join(root, "beta");

		const storeAlpha = new BankStoreBackend({ root, cwd: alpha, scoping: "per-project" });
		await storeAlpha.retain({
			kind: "decision",
			text: "The alpha project pins its dependency versions in a lockfile",
			provenance: { scope: "project", project: "alpha" },
		});
		expect((await storeAlpha.recall({ text: "dependency versions lockfile" })).length).toBe(1);

		// A different project, same store root, same shared directory on disk.
		const storeBeta = new BankStoreBackend({ root, cwd: beta, scoping: "per-project" });
		const leaked = await storeBeta.recall({ text: "dependency versions lockfile" });
		// The single most important property: a fact from one project is not
		// recalled in another, because it would be acted on as if it were true here.
		expect(leaked.length).toBe(0);

		await storeBeta.retain({
			kind: "decision",
			text: "The beta project resolves its own conflict markers per worktree",
			provenance: { scope: "project", project: "beta" },
		});
		expect((await storeAlpha.recall({ text: "conflict markers worktree" })).length).toBe(0);
		expect((await storeBeta.recall({ text: "conflict markers worktree" })).length).toBe(1);

		await storeAlpha.stop();
		await storeBeta.stop();
	});

	it("stores the same fact once however many times it is offered", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-dedup-"));
		const store = new BankStoreBackend({ root, cwd: path.join(root, "proj") });
		const fact = {
			kind: "decision" as const,
			text: "The project bank identity is derived from the absolute project path",
			provenance: { scope: "project" as const },
		};
		// The content-addressed id is what makes this hold. An earlier form mixed the
		// write timestamp into the id, so every attempt produced a new row and the
		// store accumulated 45 rows holding 17 distinct facts.
		const first = await store.retain(fact);
		const second = await store.retain(fact);
		expect(second.id).toBe(first.id);
		// Re-retaining must not refresh the timestamp either: a stale fact that looks
		// newly written starts outranking a correct one.
		expect(second.createdAt).toBe(first.createdAt);
		const hits = await store.recall({ text: "project bank identity absolute path" });
		expect(hits).toHaveLength(1);
		await store.stop();
	});

	it("collapses duplicates that predate the content-addressed id", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-legacy-dup-"));
		const cwd = path.join(root, "proj");
		const store = new BankStoreBackend({ root, cwd });
		await store.retain({
			kind: "decision",
			text: "A durable fact about the rescue bank rule",
			provenance: { scope: "project" },
		});
		await store.stop();

		// A bank file is user-writable and may hold rows written by an older version,
		// so recall collapses duplicates itself rather than trusting the id alone.
		const { DatabaseSync } = await import("node:sqlite");
		const { readdirSync } = await import("node:fs");
		const bankDir = path.join(root, "banks", readdirSync(path.join(root, "banks"))[0] as string);
		const db = new DatabaseSync(path.join(bankDir, "bank.db"));
		db.prepare(
			"INSERT INTO working_memory (id, content, kind, metadata_json, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("legacy-duplicate", "A durable fact about the rescue bank rule", "decision", "{}", cwd, Date.now());
		db.close();

		const reopened = new BankStoreBackend({ root, cwd });
		const hits = await reopened.recall({ text: "durable fact rescue bank rule" });
		// Recalling the same fact twice reads as two sources supporting one claim.
		expect(hits).toHaveLength(1);
		await reopened.stop();
	});

	it("reads back its own record after a fresh handle, proving durability", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "bank-durable-"));
		const cwd = path.join(root, "proj");
		const first = new BankStoreBackend({ root, cwd });
		await first.retain({
			kind: "convention",
			text: "The project bank survives a process restart because it is on disk",
			provenance: { scope: "project" },
		});
		await first.stop();

		const reopened = new BankStoreBackend({ root, cwd });
		expect((await reopened.recall({ text: "project bank survives restart" })).length).toBe(1);
		await reopened.stop();
	});

	it("reports an unwritable store as unavailable rather than throwing", async () => {
		// A file where a directory is needed: the mkdir genuinely fails, on any
		// platform, rather than depending on a path that Windows may happily create.
		const base = await mkdtemp(path.join(tmpdir(), "bank-unwritable-"));
		const blocked = path.join(base, "blocked");
		await writeFile(blocked, "not a directory", "utf8");

		const backend = new BankStoreBackend({ root: blocked, cwd: "/x" });
		const available = await backend.available();
		// An optional memory subsystem must never be the reason a session fails, so
		// this reports unavailability instead of throwing at construction.
		expect(available.ok).toBe(false);
		expect(available.reason).toBeTruthy();
	});

	it("surfaces a forced failure instead of returning an empty store", async () => {
		const backend = new BankStoreBackend({ root: "C:/x", cwd: "/x", failWith: "disk on fire" });
		expect((await backend.available()).ok).toBe(false);
		await expect(backend.recall({ text: "anything" })).rejects.toThrow();
	});
});

/** Creates a bank fixture mirroring the store's schema. */
async function makeBank(root: string, bank: string, cwds: readonly string[]): Promise<void> {
	const { DatabaseSync } = await import("node:sqlite");
	const directory = path.join(root, "banks", bank);
	await mkdir(directory, { recursive: true });
	const db = new DatabaseSync(path.join(directory, "bank.db"));
	db.exec(
		"CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'convention', metadata_json TEXT NOT NULL DEFAULT '{}', cwd TEXT NOT NULL DEFAULT '', superseded_by TEXT, created_at INTEGER NOT NULL)",
	);
	const insert = db.prepare(
		"INSERT INTO working_memory (id, content, metadata_json, cwd, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	// `insert.run` returns a result object; an arrow with an expression body returns it
	// from the forEach callback, which the linter rejects. The block form keeps the
	// intent — "run the insert, discard the result" — explicit.
	for (const [index, cwd] of cwds.entries()) {
		insert.run(`row-${bank}-${index}`, "content", "{}", cwd, 1);
	}
	db.close();
}
