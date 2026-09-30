import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

/**
 * Auto-resume selects a session through `SessionManager.continueRecent`.
 *
 * This file drives that function, not the policy behind it. The policy
 * (`chooseSessionToResume`) has its own unit tests, and a test written only
 * against those would stay green while production kept resuming the wrong file —
 * which is exactly the failure that put the policy on this path in the first
 * place. `--continue` and the `autoResume` setting both call `continueRecent`, so
 * this is the join the user actually experiences.
 *
 * The defect these cover: `continueRecent` picked the newest session *file*. A
 * session created by a run that ended before writing anything leaves a
 * header-only file behind, that file is the newest one on disk, and resuming it
 * yields an empty conversation that looks like the user's work was lost when it
 * never existed.
 */

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Advance a file's mtime so "newest on disk" is deterministic rather than timing-dependent. */
function makeNewest(path: string): void {
	const future = new Date(Date.now() + 3_600_000);
	utimesSync(path, future, future);
}

function headerOnlySession(path: string, cwd: string, id: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

describe("auto-resume selects the newest session that actually holds something", () => {
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = mkdtempSync(join(tmpdir(), "resume-policy-"));
		mkdirSync(join(sessionDir, "project-a"), { recursive: true });
		mkdirSync(join(sessionDir, "project-b"), { recursive: true });
	});

	afterEach(() => {
		rmSync(sessionDir, { recursive: true, force: true });
	});

	/** A session file with a real user/assistant exchange, so it has content. */
	function writeContentBearingSession(cwd: string, id: string): string {
		const session = SessionManager.create(cwd, sessionDir, { id });
		session.appendMessage({ role: "user", content: "real work" });
		session.appendMessage({
			role: "assistant",
			content: "real answer",
			model: "test",
			usage: USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const path = session.getSessionFile();
		if (!path) throw new Error("expected a persisted session file");
		return path;
	}

	const projectA = (): string => join(sessionDir, "project-a");
	const projectB = (): string => join(sessionDir, "project-b");

	it("resumes the most recent session when it holds content", () => {
		// Config A: the newest session is a real one.
		const older = writeContentBearingSession(projectA(), "older01");
		const newer = writeContentBearingSession(projectA(), "newer01");
		makeNewest(newer);

		const resumed = SessionManager.continueRecent(projectA(), sessionDir);

		expect(resumed.getSessionFile()).toBe(newer);
		expect(resumed.getSessionFile()).not.toBe(older);
		expect(resumed.buildSessionContext().messages).toHaveLength(2);
	});

	it("skips a session that holds nothing and resumes the newest one that does", () => {
		// Config B: same directory, same project, but the newest file is a
		// header-only session left by a run that ended before writing a message.
		const real = writeContentBearingSession(projectA(), "real0001");
		const empty = join(sessionDir, "2026-01-01T00-00-00-000Z_empty.jsonl");
		headerOnlySession(empty, projectA(), "empty001");
		makeNewest(empty);

		const resumed = SessionManager.continueRecent(projectA(), sessionDir);

		// The defect: this used to resolve to `empty`, a session with no messages.
		expect(resumed.getSessionFile()).toBe(real);
		expect(resumed.getSessionFile()).not.toBe(empty);
		// And this is the property auto-resume depends on: `main.ts` only keeps a
		// resumed session when it has entries, so an empty pick silently became a
		// brand new session and the user's prior conversation was dropped.
		expect(resumed.getEntries().length).toBeGreaterThan(0);
		expect(resumed.buildSessionContext().messages).toHaveLength(2);
	});

	it("skips every empty session and starts fresh when the project has no content at all", () => {
		const emptyA = join(sessionDir, "2026-01-01T00-00-00-000Z_empty-a.jsonl");
		const emptyB = join(sessionDir, "2026-01-02T00-00-00-000Z_empty-b.jsonl");
		headerOnlySession(emptyA, projectA(), "empty001");
		headerOnlySession(emptyB, projectA(), "empty002");
		makeNewest(emptyB);

		const resumed = SessionManager.continueRecent(projectA(), sessionDir);

		// A fresh session still gets a file path of its own, because that is where the
		// next turn will be written. What matters is that it is not one of the empty
		// files: resuming those would trade a wrong-session bug for a session that
		// pretends to be a history the user never had.
		expect(resumed.getSessionFile()).not.toBe(emptyA);
		expect(resumed.getSessionFile()).not.toBe(emptyB);
		expect(resumed.buildSessionContext().messages).toHaveLength(0);
	});

	it("does not resume another project's session even when that one is newer", () => {
		const mine = writeContentBearingSession(projectA(), "mine0001");
		const theirs = writeContentBearingSession(projectB(), "theirs01");
		makeNewest(theirs);

		const resumed = SessionManager.continueRecent(projectA(), sessionDir);

		expect(resumed.getSessionFile()).toBe(mine);
	});

	it("skips a file that is not a session at all", () => {
		const real = writeContentBearingSession(projectA(), "real0001");
		const corrupt = join(sessionDir, "2026-01-01T00-00-00-000Z_corrupt.jsonl");
		// A JSONL file whose first entry is not a session header: unreadable as a
		// session, so it must never be resumed regardless of its mtime.
		writeFileSync(corrupt, '{"type":"message","id":"m1","parentId":null}\n');
		makeNewest(corrupt);

		const resumed = SessionManager.continueRecent(projectA(), sessionDir);

		expect(resumed.getSessionFile()).toBe(real);
	});

	it("resumes a project with content even when the newest session elsewhere is empty", () => {
		// The two rules interact: project scoping happens first, then emptiness is
		// skipped within the project that survived it.
		const mine = writeContentBearingSession(projectA(), "mine0001");
		const theirsEmpty = join(sessionDir, "2026-01-01T00-00-00-000Z_theirs-empty.jsonl");
		headerOnlySession(theirsEmpty, projectB(), "theirse1");
		makeNewest(theirsEmpty);

		expect(SessionManager.continueRecent(projectA(), sessionDir).getSessionFile()).toBe(mine);
		expect(SessionManager.continueRecent(projectB(), sessionDir).getSessionFile()).not.toBe(theirsEmpty);
		expect(SessionManager.continueRecent(projectB(), sessionDir).buildSessionContext().messages).toHaveLength(0);
	});
});
