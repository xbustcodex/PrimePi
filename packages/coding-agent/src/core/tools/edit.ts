import type { AgentTool } from "@earendil-works/pi-agent-core";
import { checkEditAllowed, checkEditFreshness } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/**
	 * Reads a settings value by key. Supplied by the session so the edit guards
	 * follow the user configuration; absent, the built-in defaults apply.
	 */
	readSetting?: (key: string) => unknown;
	/**
	 * The digest of the content the model says it read, keyed by absolute path.
	 *
	 * Supplied by the session from its read history. A path absent from this map
	 * is not an error: a model may legitimately edit a file it is creating.
	 */
	seenDigests?: ReadonlyMap<string, string>;
	/**
	 * The session's record of which lines of which content were displayed.
	 *
	 * Supplied by the session, and consulted at the point the edit is applied
	 * rather than in the tool's preamble: an advisory check the model can route
	 * around by editing a different field is not a guard. The two responsibilities
	 * are separate on purpose. `seenDigests` answers "is this the content you
	 * read", which is a whole-file question and is what stops a stale edit. This
	 * answers "were the lines you are replacing ever displayed", which is the
	 * stronger per-line claim and is a different failure.
	 *
	 * The interface is declared here, not imported, so the tool does not depend on
	 * the index implementation and a test can supply a stub.
	 */
	seenLines?: SeenLineSource;
}

/** The session's read provenance, as the edit tool consumes it. */
export interface SeenLineSource {
	/**
	 * Whether an edit anchored on these lines may proceed.
	 *
	 * Returning `undefined` means the session has no opinion, which is how a
	 * session with no provenance store configured behaves; the edit proceeds
	 * rather than being refused for want of a guard nobody installed.
	 */
	check(input: {
		readonly absolutePath: string;
		readonly currentContent: string;
		readonly anchoredLines: readonly number[];
	}): { readonly allowed: boolean; readonly reason: string } | undefined;
	/**
	 * Records the content this tool just wrote as now-seen.
	 *
	 * Without this the guard refuses the *second* edit in any file, which is the
	 * majority of edits: the first write changes the content, so the snapshot the
	 * model read no longer matches, and every follow-up edit looks stale. A model
	 * that cannot edit retries, and a model that retries a refused edit spends its
	 * budget somewhere else — so a guard that breaks the second edit is worse than
	 * no guard at all.
	 */
	recordWrite(absolutePath: string, text: string): void;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);

				// Every guard runs before any write, so a rejected edit leaves the file
				// byte-identical rather than half-applied. The seen-line guard joins them
				// here rather than in the preamble, because at this point the anchored
				// lines are known: the matcher has just said which region of the current
				// content each edit replaces. A check made before matching would have to
				// guess the same thing, and a guard that guesses polices the wrong lines.
				const blocked = checkEditAllowed({
					blockAutoGenerated: options?.readSetting?.("edit.blockAutoGenerated") !== false,
					currentContent: content,
					path: absolutePath,
				});
				if (!blocked.ok) {
					throw new Error(blocked.detail);
				}
				const stale = checkEditFreshness({
					path: absolutePath,
					currentContent: content,
					seenDigest: options?.seenDigests?.get(absolutePath),
				});
				if (!stale.ok) {
					throw new Error(stale.detail);
				}
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent, anchoredLines } = applyEditsToNormalizedContent(
					normalizedContent,
					edits,
					path,
				);
				const seenDecision = options?.seenLines?.check({
					absolutePath,
					currentContent: content,
					anchoredLines,
				});
				if (seenDecision !== undefined && !seenDecision.allowed) {
					throw new Error(
						`${absolutePath}: ${seenDecision.reason}. Re-read the file and re-apply the edit against the current content.`,
					);
				}
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();
				// The content the model is now reasoning about is the content this tool
				// just produced, so it becomes what has been seen. Recorded before the
				// result is returned, so a follow-up edit in the same session is checked
				// against what the model actually has rather than against a snapshot that
				// this write just invalidated.
				options?.seenLines?.recordWrite(absolutePath, finalContent);

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
