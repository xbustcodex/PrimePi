import { describe, expect, it } from "vitest";
import type { JsonlSessionMetadata } from "../src/harness/session/jsonl/types.ts";
import { chooseSessionToResume, isSessionForProject } from "../src/harness/session/resume.ts";

/**
 * Resume selection.
 *
 * Every case here is a way the newest file is the *wrong* session. A wrong
 * resume is silent: the transcript opens, the model has context, and nothing
 * tells the user they are three conversations behind until they notice.
 */

/** A session, newest first as the repository returns them. */
function session(id: string, overrides: Partial<JsonlSessionMetadata> = {}): JsonlSessionMetadata {
	return {
		id,
		cwd: "/project",
		path: `/sessions/--project--/${id}.jsonl`,
		createdAt: 1_000,
		modifiedAt: 1_000,
		...overrides,
	} as JsonlSessionMetadata;
}

const hasContent = () => true;
const nothing = { sessions: [] as JsonlSessionMetadata[], hasContent };

describe("an explicit request is never second-guessed", () => {
	it("honours an explicit session id even when another is newer", () => {
		const older = session("wanted", { createdAt: 1 });
		const newer = session("other", { createdAt: 9 });
		const decision = chooseSessionToResume({ ...nothing, sessions: [newer, older], explicitId: "wanted" });
		expect(decision.source).toBe("explicit-id");
		expect(decision.metadata?.id).toBe("wanted");
	});

	it("reports a missing explicit id rather than falling back to recency", () => {
		// Silently resuming *something* when the user named a session that does not
		// exist is the worst outcome: it looks like it worked.
		const decision = chooseSessionToResume({ ...nothing, sessions: [session("other")], explicitId: "gone" });
		expect(decision.source).toBe("none");
		expect(decision.metadata).toBeUndefined();
	});

	it("honours an explicit directory across separator differences", () => {
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [session("a", { path: "/sessions/--project--/a.jsonl" })],
			explicitDir: "/sessions/--project--/a.jsonl",
		});
		expect(decision.source).toBe("explicit-dir");
	});
});

describe("a fresh-session boundary is honoured", () => {
	it("starts a new session rather than resurrecting an older transcript", () => {
		// The user asked for a new session and quit before anything was written.
		// Resuming here is exactly what the boundary exists to prevent.
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [session("old", { createdAt: 5 })],
			freshBoundary: true,
		});
		expect(decision.source).toBe("fresh-boundary");
		expect(decision.metadata).toBeUndefined();
		// A new session has no model to restore.
		expect(decision.restoreSessionModel).toBe(false);
	});

	it("beats an explicit terminal breadcrumb", () => {
		// The boundary is a more recent statement of intent than a breadcrumb
		// written before it.
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [session("old", { path: "/sessions/--project--/old.jsonl" })],
			freshBoundary: true,
			terminalSessionPath: "/sessions/--project--/old.jsonl",
		});
		expect(decision.source).toBe("fresh-boundary");
	});
});

describe("a terminal breadcrumb beats recency", () => {
	it("prefers the session this terminal was using", () => {
		const newer = session("newest", { createdAt: 9 });
		const mine = session("mine", { createdAt: 1, path: "/sessions/--project--/mine.jsonl" });
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [newer, mine],
			terminalSessionPath: "/sessions/--project--/mine.jsonl",
		});
		// The breadcrumb names the session this workspace was using, which is more
		// specific evidence than a file timestamp.
		expect(decision.source).toBe("terminal");
		expect(decision.metadata?.id).toBe("mine");
	});

	it("falls through to recency when the breadcrumb names a session that is gone", () => {
		const present = session("present", { createdAt: 1 });
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [present],
			terminalSessionPath: "/sessions/--project--/deleted.jsonl",
		});
		expect(decision.source).toBe("most-recent");
		expect(decision.metadata?.id).toBe("present");
	});
});

describe("recency, with empty sessions skipped", () => {
	it("takes the first session with content", () => {
		const decision = chooseSessionToResume({
			...nothing,
			sessions: [session("newest"), session("older")],
		});
		expect(decision.source).toBe("most-recent");
		expect(decision.metadata?.id).toBe("newest");
	});

	it("skips an empty session", () => {
		// A file that exists but holds nothing describes a run that created a
		// transcript and immediately ended. Resuming it produces an empty
		// conversation that looks like the user's work was lost.
		const decision = chooseSessionToResume({
			sessions: [session("empty"), session("real")],
			hasContent: (candidate) => candidate.id !== "empty",
		});
		expect(decision.metadata?.id).toBe("real");
	});

	it("reports a project with only empty sessions distinctly from no sessions", () => {
		const decision = chooseSessionToResume({
			sessions: [session("empty")],
			hasContent: () => false,
		});
		expect(decision.source).toBe("none");
		expect(decision.reason).toContain("empty");
	});
});

describe("resuming restores the session's own model", () => {
	it("restores for every auto-resume path", () => {
		// Resuming with a different model than the session used silently changes
		// the behaviour of a conversation the user believes is continuing.
		for (const sessions of [[session("a")], [session("a", { path: "/sessions/--project--/a.jsonl" })]]) {
			expect(chooseSessionToResume({ ...nothing, sessions }).restoreSessionModel).toBe(true);
		}
		expect(
			chooseSessionToResume({
				...nothing,
				sessions: [session("a")],
				terminalSessionPath: "/sessions/--project--/a.jsonl",
			}).restoreSessionModel,
		).toBe(true);
	});

	it("does not restore when a new session is starting", () => {
		expect(
			chooseSessionToResume({ ...nothing, sessions: [session("a")], freshBoundary: true }).restoreSessionModel,
		).toBe(false);
	});
});

describe("project identity", () => {
	it("matches on the canonical form, not the literal", () => {
		expect(isSessionForProject(session("a", { cwd: "/project" }), "/project")).toBe(true);
		// A session written on one platform can be listed on another.
		expect(isSessionForProject(session("a", { cwd: "C:\\Project" }), "c:/project/")).toBe(true);
	});

	it("does not match a different project", () => {
		expect(isSessionForProject(session("a", { cwd: "/other" }), "/project")).toBe(false);
	});
});
