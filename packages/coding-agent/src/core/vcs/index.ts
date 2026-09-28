/**
 * The VCS subsystem: one repository authority, checkpoints, and the commit
 * pipeline.
 *
 * Re-exported as a barrel so a consumer depends on the subsystem rather than on
 * three module paths, and so the dependency graph stays acyclic — nothing in
 * here imports the tool layer, and the tool layer imports only from here.
 */

export {
	type Checkpoint,
	type CheckpointOrigin,
	CheckpointStore,
	type RestoreOutcome,
	type RestoreRefusal,
	type RestoreRefusalCode,
	type RestoreResult,
	UNTRUSTED_CONTENT_NOTICE,
} from "./checkpoint-store.ts";
export {
	type CommitApprover,
	type CommitFailureCode,
	type CommitOutcome,
	CommitPipeline,
	type CommitPipelineOptions,
	type CommitPlan,
	type CommitRequest,
	type CommitValidator,
	type MessageGenerator,
	renderPreview,
	type SelectedChange,
	type SelectionRefusalCode,
	selectionFromCheckpoint,
} from "./commit-pipeline.ts";
export {
	type ChangedFile,
	type DiffResult,
	type DiffScope,
	discoverRepository,
	type GitFailureCode,
	type GitResult,
	GitService,
	type GitServiceOptions,
	isWithin,
	type RepositoryIdentity,
	type StatusSummary,
} from "./git-service.ts";
