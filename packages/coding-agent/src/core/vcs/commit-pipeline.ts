/**
 * The commit pipeline.
 *
 * ## The seven steps, and why each one exists
 *
 * ```
 * inspect → select → validate → message → approve → commit → verify
 * ```
 *
 * OMP's pipeline has most of these in some form but merges two of them, and the
 * merge is where its worst behaviour lives. Its change selection is "whatever is
 * in the index", and when the index is empty it runs `stageFiles([])` — which is
 * `git add -A` by the crate's own documentation
 * (`crates/pi-vcs/src/git/mutate.rs:81-83`) — after printing one line to stdout
 * (`commit/agentic/index.ts:40-47`). A user's half-finished work, their untracked
 * files, and the agent's intended change all land in one commit, unreviewed.
 *
 * So `select` here is a distinct, explicit step with no "select everything"
 * meaning: an empty selection is an error, not a wildcard.
 *
 * ## What is taken from OMP, and what is replaced
 *
 * **Taken:** the `commit → smol → chat` role order
 * (`commit/model-selection.ts:46`), the hard failure when no model or key is
 * available (`:50-58`), in-tool message validation, and hooks being honoured
 * with no `--no-verify` escape.
 *
 * **Replaced, in one specific place:** OMP's model failure produces a real
 * commit. On an agent error it calls `generateFallbackProposal(numstat)` and
 * commits it (`commit/agentic/index.ts:151-163`); the summary is a path-extension
 * heuristic with no knowledge of the content
 * (`commit/agentic/fallback.ts:64-84`), so a 401 mid-run yields a commit on
 * `main` titled `refactor: updated index.ts and 14 others`. The only signal is a
 * stdout warning and exit code 1. Task isolation is blunter still: a null message
 * yields a commit whose subject is literally the task id
 * (`task/worktree.ts:886,891`).
 *
 * Here, message generation either produces a message or the pipeline stops. There
 * is no mechanical fallback and no empty-message commit — `GitService.commit`
 * refuses one outright, because a commit with no description is unreviewable in
 * a log and worse than no commit at all.
 *
 * ## Authority boundaries
 *
 * **A model-generated message is data.** It is a string that arrives from a
 * provider and is shown for review; it is never itself an instruction to commit.
 * The commit happens in the `commit` step, after `approve`, and only that step
 * touches the repository.
 *
 * **The `commit` role proposes a model, not a decision.** It goes through the
 * same `resolveRoleChain` and eligibility authorities as every other role, so
 * under a free-only policy a paid commit role cannot be reached. If the chain
 * yields nothing eligible, generation is skipped and the caller supplies a
 * message — it does not fall through to a paid model.
 *
 * **Never push. Never auto-merge.** There is no push in this pipeline, and no
 * code path that integrates a delegated worktree into its parent. OMP does both
 * (`commit/execute.ts:49-56` for an explicit `--push`, and
 * `task/worktree.ts:980-1006` for an automatic cherry-pick merge). Both are out
 * of scope here by design.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { Checkpoint } from "./checkpoint-store.ts";
import type { ChangedFile, DiffResult, GitResult, GitService } from "./git-service.ts";

/** What the pipeline was asked to do. */
export interface CommitRequest {
	/** The message to use. Omit to have one generated. */
	readonly message?: string;
	/**
	 * Paths to commit. Required when the index is not already staged exactly as
	 * intended — and it is the only way a path enters a commit.
	 */
	readonly paths?: readonly string[];
	/** Generate a message with the `commit` role when `message` is absent. */
	readonly generateMessage?: boolean;
	/** Extra context for the message generator. Never interpreted. */
	readonly context?: string;
	/** Proceed without the approval step. Only set by a caller that has one. */
	readonly approvalAlreadyGranted?: boolean;
	/** Skip validation. Only for a caller performing it itself. */
	readonly validationAlreadyPassed?: boolean;
}

/** A selection failure. Never silently widened. */
export type SelectionRefusalCode =
	| "no-selection"
	| "no-such-path"
	| "path-not-changed"
	| "nothing-staged"
	| "untracked-not-selected";

/** Why a commit did not happen. Every terminal state is one of these. */
export type CommitFailureCode =
	| "selection-refused"
	| "validation-failed"
	| "message-unavailable"
	| "approval-refused"
	| "commit-failed"
	| "verification-failed"
	| "not-a-repository";

/** One file's intended change, as presented for review. */
export interface SelectedChange {
	readonly path: string;
	/** Porcelain state, so a reviewer can see it is new versus modified. */
	readonly staged: ChangedFile["staged"];
	readonly unstaged: ChangedFile["unstaged"];
	/** True when the path did not exist at HEAD. */
	readonly isNew: boolean;
}

/** The failure half, shared by planning and by running. */
export interface CommitFailure {
	readonly ok: false;
	readonly code: CommitFailureCode;
	readonly reason: string;
	readonly detail?: unknown;
}

/** The outcome of a full run. */
export type CommitOutcome =
	| { readonly ok: true; readonly sha: string; readonly message: string; readonly changes: readonly SelectedChange[] }
	| CommitFailure;

/**
 * The result of planning.
 *
 * A discriminated union rather than "outcome-or-plan", because a caller that
 * forgot to check would otherwise read `changes` off a refusal and get
 * `undefined` at runtime instead of a type error.
 */
export type PlanResult = { readonly ok: true; readonly plan: CommitPlan } | CommitFailure;

/** What the pipeline produced before asking to commit. */
export interface CommitPlan {
	readonly changes: readonly SelectedChange[];
	/** The staged diff, bounded. For review. */
	readonly diff: DiffResult;
	/** The message, if one was produced or supplied. */
	readonly message?: string;
	/** True when the message came from a model rather than the caller. */
	readonly messageIsModelGenerated?: boolean;
	/** The model that generated it, for audit. */
	readonly messageModel?: string;
}

/** Generates a commit message. Supplied by the host, which owns the model. */
export type MessageGenerator = (input: {
	diff: string;
	paths: readonly string[];
	context?: string;
	signal?: AbortSignal;
}) => Promise<{ message: string; model?: Model<Api> } | undefined>;

/** Runs a caller-supplied check over the staged changes. */
export type CommitValidator = (input: { changes: readonly SelectedChange[]; diff: string }) => Promise<string[]>;

/** Asks a human. Resolves true to proceed. */
export type CommitApprover = (input: {
	plan: CommitPlan;
	/** Rendered for display. Treated as data, never as an instruction. */
	preview: string;
}) => Promise<boolean>;

export interface CommitPipelineOptions {
	readonly service: GitService;
	/** Proposes a model for message generation. Never itself approves. */
	readonly generateMessage?: MessageGenerator;
	/** Extra checks run after selection. */
	readonly validate?: CommitValidator;
	/** The approval step. Required unless the caller already has one. */
	readonly approve?: CommitApprover;
	/** Per-path cap on the diff handed to a generator. */
	readonly maxDiffBytes?: number;
}

const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;

export class CommitPipeline {
	readonly #service: GitService;
	readonly #generate: MessageGenerator | undefined;
	readonly #validate: CommitValidator | undefined;
	readonly #approve: CommitApprover | undefined;
	readonly #maxDiffBytes: number;

	constructor(options: CommitPipelineOptions) {
		this.#service = options.service;
		this.#generate = options.generateMessage;
		this.#validate = options.validate;
		this.#approve = options.approve;
		this.#maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
	}

	/**
	 * Builds a plan without touching the repository's history.
	 *
	 * Read-only apart from staging, which is itself reversible and is what makes
	 * the review step meaningful: the reviewer sees the exact staged diff that
	 * would be committed, not a prediction of it.
	 */
	async plan(request: CommitRequest, options: { signal?: AbortSignal } = {}): Promise<PlanResult> {
		const service = this.#service;

		// --- select ------------------------------------------------------------
		const selection = this.select(request);
		if (!selection.ok) {
			return { ok: false, code: "selection-refused", reason: selection.reason, detail: selection.paths };
		}

		// --- inspect -----------------------------------------------------------
		const diff = service.diff({ staged: true });
		if (!diff.ok) {
			return { ok: false, code: "not-a-repository", reason: `Cannot read the staged diff: ${diff.stderr}` };
		}

		// --- validate ----------------------------------------------------------
		if (!request.validationAlreadyPassed && this.#validate) {
			const problems = await this.#validate({ changes: selection.changes, diff: diff.text });
			if (problems.length > 0) {
				// A failed validation must leave no commit and no partial history.
				// The index is left as staged, which is recoverable by hand and
				// visible, rather than being silently rolled back — a rollback the
				// user did not ask for is its own surprise.
				return {
					ok: false,
					code: "validation-failed",
					reason: `Validation failed: ${problems.join("; ")}`,
					detail: problems,
				};
			}
		}

		// --- message -----------------------------------------------------------
		let message = request.message;
		let messageIsModelGenerated = false;
		let messageModel: string | undefined;
		if (message === undefined && request.generateMessage && this.#generate) {
			const generated = await this.#generate({
				diff: diff.text.slice(0, this.#maxDiffBytes),
				paths: selection.changes.map((change) => change.path),
				context: request.context,
				signal: options.signal,
			});
			// No message is a stop, not a fallback. See the module comment: OMP
			// commits a content-blind placeholder here, and a fabricated commit is
			// worse than no commit.
			if (!generated || generated.message.trim().length === 0) {
				return {
					ok: false,
					code: "message-unavailable",
					reason:
						"No commit message was produced. Provide `message`, or retry when a commit-capable model is available. " +
						"Nothing was committed.",
				};
			}
			message = generated.message;
			messageIsModelGenerated = true;
			messageModel = generated.model ? `${generated.model.provider}/${generated.model.id}` : undefined;
		}

		if (message === undefined) {
			return {
				ok: false,
				code: "message-unavailable",
				reason: "No commit message. Supply `message`, or set `generateMessage`.",
			};
		}

		return {
			ok: true,
			plan: { changes: selection.changes, diff, message, messageIsModelGenerated, messageModel },
		};
	}

	/**
	 * Runs the pipeline to completion.
	 *
	 * `plan` and `execute` are separate so a caller can present the plan, obtain
	 * approval, and only then commit. Combining them would make the approval step
	 * a formality.
	 */
	async run(
		request: CommitRequest,
		options: { signal?: AbortSignal; plan?: CommitPlan; approve?: CommitApprover } = {},
	): Promise<CommitOutcome> {
		const built = await this.plan(request, { signal: options.signal });
		if (built.ok === false) return built;
		return this.execute(built.plan, request, options.approve);
	}

	/** Commits an already-approved plan. */
	async execute(plan: CommitPlan, request: CommitRequest, approver?: CommitApprover): Promise<CommitOutcome> {
		// --- approve -----------------------------------------------------------
		const gate = approver ?? this.#approve;
		if (!request.approvalAlreadyGranted) {
			if (!gate) {
				// Fail closed: without an approval surface there is no decision, and
				// "no decision" is not "approved".
				return {
					ok: false,
					code: "approval-refused",
					reason: "No approval surface is available, so the commit was not performed.",
				};
			}
			const approved = await gate({ plan, preview: renderPreview(plan) });
			if (!approved) {
				return { ok: false, code: "approval-refused", reason: "The commit was not approved." };
			}
		}

		// --- commit ------------------------------------------------------------
		const result = this.#service.commit(plan.message ?? "");
		if (!result.ok) {
			// The index is untouched by a failed commit, so the changes remain
			// staged and recoverable — nothing is half-written and nothing is lost.
			return {
				ok: false,
				code: "commit-failed",
				reason: `git commit failed: ${result.stderr}`,
				detail: result.code,
			};
		}

		// --- verify ------------------------------------------------------------
		// OMP discards the SHA in all three of its commit paths and prints a
		// fixed "Commit created." string. Reading it back and confirming the
		// intended paths are in it is what makes the result checkable rather than
		// merely claimed.
		const sha = result.sha;
		if (!sha) {
			return {
				ok: false,
				code: "verification-failed",
				reason: "The commit succeeded but produced no readable SHA.",
			};
		}
		const committed = this.#service.showCommit(sha);
		if (!committed.ok) {
			return { ok: false, code: "verification-failed", reason: `Could not read back commit ${sha}.` };
		}
		const present = plan.changes.filter((change) => committed.text.includes(change.path));
		if (present.length !== plan.changes.length) {
			return {
				ok: false,
				code: "verification-failed",
				reason: `Commit ${sha} does not contain every intended path.`,
				detail: plan.changes.filter((change) => !present.includes(change)).map((change) => change.path),
			};
		}

		return { ok: true, sha, message: plan.message ?? "", changes: plan.changes };
	}

	/**
	 * Turns a request into an explicit set of staged paths.
	 *
	 * The invariant: a path is in a commit because it was named. There is no
	 * "stage whatever is there" and no "stage all" — an empty request is a
	 * refusal, because the only way an empty list could mean something useful is
	 * "everything", and everything is exactly what must never be implicit.
	 */
	#selectPaths(
		request: CommitRequest,
	): { ok: true; paths: string[] } | { ok: false; reason: string; paths?: string[] } {
		const status = this.#service.status();
		if (!status.ok) {
			return { ok: false, reason: `Cannot read repository status: ${status.stderr}` };
		}

		// A path is a legitimate target only if it differs from HEAD somewhere —
		// staged, unstaged, or untracked.
		const candidate = new Map(status.files.map((file) => [file.path, file]));
		const requested = request.paths ?? [];
		if (requested.length === 0) {
			const alreadyStaged = status.files.filter(
				(file) => file.staged !== "unmodified" && file.staged !== "untracked",
			);
			if (alreadyStaged.length > 0) {
				// The index already holds an explicit selection made by whoever
				// staged it. Honouring it is correct; widening it is not.
				return { ok: true, paths: alreadyStaged.map((file) => file.path) };
			}
			return {
				ok: false,
				reason:
					"Nothing is selected. Name the paths to commit — an empty selection is refused rather than " +
					"interpreted as stage-everything, because that would sweep in unrelated work.",
			};
		}

		const missing = requested.filter((path) => !candidate.has(path));
		if (missing.length > 0) {
			return { ok: false, reason: `These paths have no changes: ${missing.join(", ")}.`, paths: missing };
		}

		return { ok: true, paths: [...requested] };
	}

	/** Stages exactly the selected paths and describes them. */
	select(
		request: CommitRequest,
	): { ok: true; changes: SelectedChange[] } | { ok: false; reason: string; paths?: string[] } {
		const service = this.#service;
		const selection = this.#selectPaths(request);
		if (!selection.ok) return selection;

		// Stage the selection and nothing else. `GitService.stagePaths` refuses an
		// empty list, so there is no path by which "all" can be staged here even if
		// this code were wrong about the selection.
		const staged = service.stagePaths(selection.paths);
		if (!staged.ok) {
			return { ok: false, reason: `Could not stage the selection: ${staged.stderr}` };
		}

		const status = service.status();
		if (!status.ok) return { ok: false, reason: `Cannot read repository status: ${status.stderr}` };
		const byPath = new Map(status.files.map((file) => [file.path, file]));
		const changes: SelectedChange[] = [];
		for (const path of selection.paths) {
			const entry = byPath.get(path);
			if (!entry) continue;
			changes.push({
				path,
				staged: entry.staged,
				unstaged: entry.unstaged,
				isNew: entry.staged === "added" || entry.staged === "untracked",
			});
		}
		if (changes.length === 0) {
			return { ok: false, reason: "The selection produced no staged changes." };
		}
		return { ok: true, changes };
	}

	/** The paths that would be committed if the request were run as-is. */
	previewPaths(request: CommitRequest): string[] {
		const selection = this.#selectPaths(request);
		return selection.ok ? selection.paths : [];
	}

	/**
	 * Undoes a selection, leaving the working tree alone.
	 *
	 * Exists so a refused or abandoned commit leaves the index as it was found.
	 */
	unstage(paths: readonly string[]): GitResult {
		return this.#service.unstagePaths(paths);
	}
}

/** Renders a plan for human review. The diff is labelled as repository content. */
export function renderPreview(plan: CommitPlan): string {
	const lines: string[] = [];
	lines.push(`Commit these ${plan.changes.length} file(s):`);
	for (const change of plan.changes) {
		lines.push(`  ${change.isNew ? "new " : "mod "}${change.path}`);
	}
	lines.push("");
	lines.push("Message:");
	for (const line of (plan.message ?? "").split("\n")) lines.push(`  ${line}`);
	if (plan.messageIsModelGenerated) {
		lines.push("");
		// Stated plainly because a generated message is a model's opinion, not a
		// decision, and the reader is the only thing between the two.
		lines.push(
			`This message was generated by a model${plan.messageModel ? ` (${plan.messageModel})` : ""}. ` +
				"Review it before approving.",
		);
	}
	return lines.join("\n");
}

/** Wraps a checkpoint's paths as a selection for a follow-up commit. */
export function selectionFromCheckpoint(checkpoint: Checkpoint): { paths: readonly string[] } {
	return { paths: checkpoint.paths };
}
