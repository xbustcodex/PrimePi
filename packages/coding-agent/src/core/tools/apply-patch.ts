/**
 * The `apply_patch` tool: a diff-shaped alternative to `edit`.
 *
 * ## Why a second mutation tool rather than a flag on `edit`
 *
 * `edit` takes text the model quotes; a patch is text the model constructs.
 * They are different failure modes: a quoted block is wrong if it does not
 * match, while a patch is wrong if its hunk lands in the wrong place. Keeping
 * them as separate tools means the model chooses the shape, and each one is
 * validated on its own terms.
 *
 * ## The authority properties, stated here and enforced in `../edit/patch.ts`
 *
 * **A patch is untrusted model output.** The `+++` header names a file, and a
 * file named in a model message is not a file the tool may write. Every target
 * goes through `resolvePatchTarget`, which refuses anything that leaves the
 * workspace — including via a symlink planted inside it — and rebases absolute
 * paths rather than honouring them.
 *
 * **Every mutation is still an edit.** This tool stages nothing, commits
 * nothing, and moves nothing. It writes file content, and that write is
 * classified `write`, so it is gated by exactly the same approval decision and
 * refused by the same Plan Mode barrier as `edit`. There is no privileged path
 * into the filesystem here.
 *
 * **All hunks or none.** A patch whose second hunk cannot be placed is refused
 * with the file untouched, because a partially applied patch is what makes a
 * retry corrupt a file.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import {
	applyPatch,
	type HunkApplyError,
	type PatchParseError,
	parsePatch,
	resolvePatchTarget,
} from "../edit/patch.ts";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const applyPatchSchema = Type.Object({
	patch: Type.String({
		description:
			"A unified diff. It must start with `--- a/<path>` and `+++ b/<path>` and use `@@ -start,count +start,count @@` hunk headers. " +
			"The `@@` line numbers are a hint; the hunk is located by its context, so a patch generated from a slightly different revision still applies.",
	}),
	/** Override the workspace root. Only for tests and remote hosts. */
	cwd: Type.Optional(
		Type.String({ description: "Directory the patch is applied relative to (default: session cwd)." }),
	),
});

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>;

/** Filesystem operations, injected so a test or a remote host can substitute them. */
export interface ApplyPatchOperations {
	readFile: (absolutePath: string) => Promise<string>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	exists: (absolutePath: string) => boolean;
}

const defaultOperations: ApplyPatchOperations = {
	readFile: (path) => readFile(path, "utf8"),
	writeFile: (path, content) => writeFile(path, content, "utf8"),
	exists: existsSync,
};

export interface ApplyPatchToolDetails {
	/** True when nothing was written and the patch was refused. */
	applied: boolean;
	/** Why a patch was refused, when it was. */
	refused?: string;
	/** The resolved workspace-relative path that was written. */
	path: string;
	/** Hunk headers applied, in patch order. */
	hunks: string[];
	/** Unified diff of the change, for review. */
	diff: string;
	/** True when the file did not exist before. */
	created: boolean;
}

/** A unified diff of `before` → `after`, for the tool result. */
function renderDiff(path: string, before: string, after: string): string {
	if (before === after) return "";
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	// A line-level diff is enough for review: the authoritative change is the
	// hunk headers the patch declared, reported separately.
	let start = 0;
	while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;
	let beforeEnd = beforeLines.length;
	let afterEnd = afterLines.length;
	while (beforeEnd > start && afterEnd > start && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
		beforeEnd--;
		afterEnd--;
	}
	const lines = [`--- a/${path}`, `+++ b/${path}`];
	for (const line of beforeLines.slice(start, beforeEnd)) lines.push(`-${line}`);
	for (const line of afterLines.slice(start, afterEnd)) lines.push(`+${line}`);
	return lines.join("\n");
}

/** Renders a path relative to the root, for display. */
function displayPath(root: string, absolute: string): string {
	const rel = relative(root, absolute);
	return rel.length > 0 && !isAbsolute(rel) ? rel : absolute;
}

export function createApplyPatchToolDefinition(
	options: { root: string; operations?: ApplyPatchOperations } = { root: process.cwd() },
): ToolDefinition<typeof applyPatchSchema, ApplyPatchToolDetails> {
	const operations = options.operations ?? defaultOperations;
	return {
		name: "apply_patch",
		label: "Apply Patch",
		description:
			"Apply a unified diff to a file. The patch's target path is resolved inside the workspace and refused if it points outside. " +
			"All hunks are located and checked before anything is written, so a patch that cannot be applied completely is refused rather than half-applied. " +
			"Prefer `edit` for a small targeted change you can quote exactly; use this for a long change you have already diffed.",
		promptSnippet: "Apply a unified diff to a file",
		promptGuidelines: [
			"A `+++ b/<path>` header is a request, not a permission: a path outside the workspace is refused.",
			"Hunks are matched by context, not by line number, so a stale line number is not a failure — but a hunk whose context does not exist is.",
			"Only the file the patch names is written. Nothing is staged, committed, or moved.",
		],
		parameters: applyPatchSchema,
		async execute(_toolCallId, params: ApplyPatchToolInput): Promise<AgentToolResult<ApplyPatchToolDetails>> {
			const root = options.root;
			const parsed = parsePatch(params.patch);
			if (!parsed.ok) {
				// A parse failure is a refusal with the reason, never a partial
				// application of whatever prefix happened to parse.
				return {
					content: [{ type: "text", text: `Patch not applied: ${describeParseError(parsed.error)}` }],
					details: {
						applied: false,
						refused: describeParseError(parsed.error),
						path: "",
						hunks: [],
						diff: "",
						created: false,
					},
				};
			}

			// The security boundary: a path in a model message becomes a real path
			// only here, and only if it stays inside the workspace.
			const target = resolvePatchTarget(parsed.patch.target, { root });
			if (!target.ok) {
				return {
					content: [{ type: "text", text: `Patch not applied: ${target.reason}` }],
					details: { applied: false, refused: target.reason, path: "", hunks: [], diff: "", created: false },
				};
			}
			if (!target.isCreate) {
				// A patch may only write a file inside the workspace, and a
				// pre-existing file must also be one the session can already read;
				// `read` above is that check.
			}

			const display = displayPath(root, target.path);
			const before = target.isCreate ? "" : await operations.readFile(target.path);
			const applied = applyPatch(before, parsed.patch);
			if (!applied.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Patch not applied to ${display}: ${describeApplyError(applied.error)}. Nothing was written.`,
						},
					],
					details: {
						applied: false,
						refused: describeApplyError(applied.error),
						path: display,
						hunks: [],
						diff: "",
						created: false,
					},
				};
			}

			// Through the shared queue so a patch cannot interleave with a
			// concurrent `edit` to the same file.
			await withFileMutationQueue(target.path, async () => {
				await operations.writeFile(target.path, applied.content);
			});

			return {
				content: [
					{
						type: "text",
						text:
							`Applied ${applied.applied} hunk(s) to ${display}.` +
							(target.isCreate ? " (created)" : "") +
							"\n\n" +
							renderDiff(display, before, applied.content),
					},
				],
				details: {
					applied: true,
					path: display,
					hunks: parsed.patch.hunks.map((hunk) => hunk.header),
					diff: renderDiff(display, before, applied.content),
					created: target.isCreate,
				},
			};
		},
	};
}

function describeParseError(error: PatchParseError): string {
	switch (error.kind) {
		case "no-target":
			return "the patch has no `+++ b/<path>` target line.";
		case "no-hunks":
			return "the patch contains no `@@` hunks.";
		case "too-large":
			return `the patch is ${error.bytes} bytes, over the ${error.limit} limit.`;
		case "malformed-header":
			return `a hunk header could not be parsed: ${error.line}`;
		default:
			return "the patch could not be parsed.";
	}
}

function describeApplyError(error: HunkApplyError): string {
	switch (error.kind) {
		case "not-found":
			return `the context for ${error.header} does not exist in the file.`;
		case "ambiguous":
			return `the context for ${error.header} appears at lines ${error.lines?.join(", ")}, so the hunk cannot be placed unambiguously.`;
		case "overlap":
			return `${error.header} overlaps an earlier hunk.`;
		default:
			return "the patch could not be applied.";
	}
}

export function createApplyPatchTool(options: { root: string; operations?: ApplyPatchOperations }) {
	return wrapToolDefinition(createApplyPatchToolDefinition(options));
}

export { dirname, resolve };
