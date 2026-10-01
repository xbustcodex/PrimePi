/**
 * Choosing which session to resume.
 *
 * ## The problem this solves
 *
 * A user reopens a project and expects the last conversation. "The last
 * conversation" is not simply the newest file: a session can be newer and still
 * be the wrong one. This module encodes the cases where that happens, because
 * each of them silently resumes a transcript the user did not ask for, and a
 * resumed transcript looks exactly like a correct one until the user notices
 * they are three conversations behind.
 *
 * ## The cases, in the order they are checked
 *
 * 1. **An explicit request wins.** A session id or a named directory is the
 *    user being specific. Auto-resume must never second-guess that.
 * 2. **A fresh-session boundary is honoured.** If the user asked for a new
 *    session and then quit before anything was written, the next launch starts
 *    a new session. Falling back to "most recent" here resurrects a transcript
 *    from a previous run, which is precisely what the boundary was for.
 * 3. **A session for this project wins over one from elsewhere.** Resuming a
 *    different project's transcript because it is newer is the worst outcome:
 *    the model has context the user never gave it, about code they are not in.
 * 4. **A recorded session for this terminal wins over recency.** If this
 *    terminal was working on a session here, that is more specific evidence
 *    than a file timestamp.
 * 5. **Otherwise, the most recently modified session for this project.**
 *
 * ## Why a session with no content is skipped
 *
 * A session file that exists but holds nothing describes a run that created a
 * transcript and immediately ended. Resuming it produces an empty conversation
 * that *looks* like the user's work was lost, when in fact it never existed.
 * The exception is case 2, where an empty session is exactly the right answer
 * because the boundary deliberately created it.
 */

/**
 * Canonicalise a path for cross-platform comparison, without `node:path`.
 *
	return canonicalPath(session.cwd) === canonicalPath(projectCwd);
 * for `platform: "browser"`, where a node specifier cannot resolve. The only part of
 * `resolve` this needed was collapsing `.` and `..` segments; absolute-prefix handling
 * was dead weight, because both sides are repository-recorded cwds that are already
 * absolute.
 *
 * `path.posix.resolve` would not do: the input may use Windows separators, so the
 * segments have to be split on both before being rejoined.
 */
function canonicalPath(value: string): string {
	const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
	const out: string[] = [];
	for (const segment of segments) {
		if (segment === ".") continue;
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out.join("/").toLowerCase();
}

import type { JsonlSessionMetadata } from "./jsonl/types.ts";

/** How a resume decision was reached, for a status line and for tests. */
export type ResumeSource = "explicit-id" | "explicit-dir" | "fresh-boundary" | "terminal" | "most-recent" | "none";

export interface ResumeDecision {
	readonly source: ResumeSource;
	/** The session to open, or `undefined` when a new one should be created. */
	readonly metadata?: JsonlSessionMetadata;
	/**
	 * True when the session's own model and thinking level must be restored
	 * instead of being overridden by CLI defaults.
	 *
	 * This matters because resuming with a different model than the session used
	 * silently changes the behaviour of a conversation the user believes is
	 * continuing. Auto-resume sets it; an explicit request may not, because the
	 * user is choosing a model on purpose.
	 */
	readonly restoreSessionModel: boolean;
	/** Why, in one line. */
	readonly reason: string;
}

export interface ResumeInputs {
	/** Every session known for this project, newest first. */
	readonly sessions: readonly JsonlSessionMetadata[];
	/** An explicit session id from the command line. */
	readonly explicitId?: string;
	/** An explicit session directory from the command line. */
	readonly explicitDir?: string;
	/** The last session this terminal was working on, if recorded. */
	readonly terminalSessionPath?: string;
	/**
	 * The user asked for a new session, and the resulting transcript was never
	 * written.
	 */
	readonly freshBoundary?: boolean;
	/** Whether a session has any content. Empty sessions are skipped. */
	readonly hasContent: (metadata: JsonlSessionMetadata) => boolean;
}

/** True when `candidate` is the same file as `path`, across separator forms. */
function samePath(left: string, right: string): boolean {
	const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return normalise(left) === normalise(right);
}

/**
 * Decides which session to resume.
 *
 * Pure: every input is a parameter, so the decision is testable without a
 * filesystem and cannot depend on ambient state.
 */
export function chooseSessionToResume(inputs: ResumeInputs): ResumeDecision {
	const { sessions } = inputs;

	// 1. An explicit request is the user being specific. Never second-guess it.
	if (inputs.explicitId) {
		const found = sessions.find((session) => session.id === inputs.explicitId);
		return found
			? {
					source: "explicit-id",
					metadata: found,
					restoreSessionModel: true,
					reason: `session ${found.id} requested`,
				}
			: { source: "none", restoreSessionModel: false, reason: `session ${inputs.explicitId} not found` };
	}
	if (inputs.explicitDir) {
		const found = sessions.find((session) => samePath(session.path, inputs.explicitDir!));
		return found
			? { source: "explicit-dir", metadata: found, restoreSessionModel: true, reason: "session directory requested" }
			: { source: "none", restoreSessionModel: false, reason: "the requested session directory holds no session" };
	}

	// 2. A fresh-session boundary the user asked for. Resuming here would
	// resurrect a transcript from a previous run, which is what the boundary
	// exists to prevent.
	if (inputs.freshBoundary) {
		return {
			source: "fresh-boundary",
			restoreSessionModel: false,
			reason: "the last run started a new session and wrote nothing",
		};
	}

	// 4. Checked before recency: a terminal breadcrumb is more specific evidence
	// than a file timestamp, and it names the session this workspace was using.
	if (inputs.terminalSessionPath) {
		const found = sessions.find((session) => samePath(session.path, inputs.terminalSessionPath!));
		if (found) {
			return {
				source: "terminal",
				metadata: found,
				restoreSessionModel: true,
				reason: "the session this terminal was working on",
			};
		}
	}

	// 3 and 5. A session for this project, most recently modified first. The list
	// arrives sorted newest-first, so the first usable entry is the answer.
	const usable = sessions.filter(inputs.hasContent);
	const first = usable[0];
	if (!first) {
		return {
			source: "none",
			restoreSessionModel: false,
			reason: sessions.length === 0 ? "no session for this project" : "every session for this project is empty",
		};
	}
	return {
		source: "most-recent",
		metadata: first,
		restoreSessionModel: true,
		reason: "the most recent session for this project",
	};
}

/**
 * Whether a session belongs to a project, compared canonically.
 *
 * The repository already stores the canonical cwd, so this is a comparison
 * rather than a normalisation - but the comparison still has to tolerate
 * separator and case differences, because a session written on one platform can
 * be listed on another.
 */
export function isSessionForProject(session: JsonlSessionMetadata, projectCwd: string): boolean {
	return canonicalPath(session.cwd) === canonicalPath(projectCwd);
}
