/**
 * Worktree isolation: how a delegated task's changes reach the user's checkout.
 *
 * ## Why a task gets its own worktree at all
 *
 * A subagent that edits the user's working directory is editing something the
 * user is also looking at. If the task is wrong, the user has a dirty tree they
 * did not make and must disentangle. Isolation moves the work somewhere that
 * cannot surprise them.
 *
 * ## Two integration strategies, and they are not equivalent
 *
 * **patch** combines the task's diffs and applies them with `git apply`. Nothing
 * is committed; the user reviews the result as working-tree changes and can
 * discard them with `git checkout`. A task that turns out to be wrong costs
 * nothing.
 *
 * **branch** commits per task and merges with `--no-ff`, preserving the work as
 * a reviewable history. A task that turns out to be wrong costs a revert, and
 * the `--no-ff` is what keeps that revert meaningful: a fast-forward merge
 * leaves no commit to revert *to*.
 *
 * `patch` is the default because reviewing uncommitted changes is the cheaper
 * mistake. Neither is safe by default, and the choice belongs to the user.
 *
 * ## Isolation is not a security boundary
 *
 * A worktree shares the repository's object store, hooks and configuration. It
 * isolates *changes in progress*, not authority: an agent with the same
 * credentials can reach the same remotes. Treating it as a sandbox is the
 * failure this module's docs exist to prevent.
 */

/** How isolated changes are integrated. */
export type MergeStrategy = "patch" | "branch";

/** The commit message style for nested-repository changes. */
export type CommitStyle = "generic" | "ai";

export interface IsolationSettings {
	/** Give a delegated task its own worktree. */
	readonly enabled: boolean;
	/** How its changes are integrated. */
	readonly merge: MergeStrategy;
	/** Commit message style when a commit is made. */
	readonly commits: CommitStyle;
	/** Apply the task's changes to the user's tree. Off means discard them. */
	readonly apply: boolean;
	/** Clone the checkout into the worktree rather than adding one. */
	readonly clone: boolean;
	/** Clean the source checkout when the worktree is removed. */
	readonly cleanSource: boolean;
	/** The base directory worktrees are created under. */
	readonly base?: string;
}

export const DEFAULT_ISOLATION: IsolationSettings = {
	enabled: false,
	merge: "patch",
	commits: "generic",
	apply: false,
	clone: false,
	cleanSource: false,
};

export type IsolationDecision =
	| { readonly action: "merge"; readonly strategy: MergeStrategy; readonly reason: string }
	| { readonly action: "discard"; readonly reason: string }
	| { readonly action: "require-approval"; readonly reason: string };

/**
 * Decides what happens to an isolated task's changes when it finishes.
 *
 * Three outcomes, and the middle one is the point: with `apply` off, a finished
 * task's work is **discarded rather than merged**, which is what makes an
 * experimental delegation safe to run.
 */
export function decideIntegration(
	settings: IsolationSettings,
	context: { readonly taskSucceeded: boolean },
): IsolationDecision {
	if (!settings.enabled) {
		// Without isolation the task wrote straight into the user's tree, so there is
		// nothing to integrate and nothing to discard.
		return { action: "merge", strategy: settings.merge, reason: "isolation is off, so the task worked in place" };
	}
	if (context.taskSucceeded === false) {
		// A failed task's changes are the most likely to be wrong, and the user
		// asked for a result, not for a mess.
		return { action: "discard", reason: "the task failed, so its changes are discarded rather than integrated" };
	}
	if (!settings.apply) {
		return {
			action: "discard",
			// What makes an experimental delegation safe to run.
			reason:
				"isolated changes are not applied unless asked for, so a finished task leaves the working tree untouched",
		};
	}
	return {
		action: "merge",
		strategy: settings.merge,
		reason:
			settings.merge === "patch"
				? "combined diffs will be applied to the working tree for review"
				: "a commit will be made per task and merged with --no-ff, so a revert stays possible",
	};
}

/** What a strategy costs when the task turns out to be wrong. */
export function describeMergeCost(strategy: MergeStrategy): string {
	return strategy === "patch"
		? "Nothing is committed, so a wrong result is discarded with git checkout."
		: "A commit is made, so a wrong result costs a revert. --no-ff keeps the pre-merge commit reachable.";
}

/** Why `--no-ff` is not optional for a branch merge. */
export function requiresNoFastForward(): boolean {
	// A fast-forward merge leaves no commit to revert *to*: the branch pointer
	// simply moves. The merge commit is what makes the pre-merge state
	// addressable at all.
	return true;
}

export interface WorktreePlan {
	readonly path: string;
	readonly base?: string;
	readonly reason: string;
}

/**
 * Plans a worktree directory.
 *
 * The path is derived from the task, not invented, so two delegations of the same
 * task cannot collide on one directory - and a collision is how one task's
 * uncommitted changes end up in another's review.
 */
export function planWorktreePath(input: {
	readonly base: string;
	readonly taskId: string;
	readonly cwd: string;
}): WorktreePlan {
	// The task id is sanitised because it reaches a filesystem path, and a
	// separator in it would place the worktree somewhere the user did not choose.
	const slug = input.taskId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || "task";
	return {
		path: `${input.base.replace(/[/\\]+$/, "")}/${slug}`,
		base: input.cwd,
		reason: "derived from the task id, so two delegations cannot collide on one directory",
	};
}

/** One line for a settings hint, naming what isolation is and is not. */
export function describeIsolation(): string {
	return "A worktree isolates changes in progress. It shares the repository objects, hooks and credentials, so it is not a sandbox.";
}
