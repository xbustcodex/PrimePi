/**
 * Tool-output pruning: reclaim prompt budget from tool results that are no
 * longer worth their tokens.
 *
 * ## Why this exists
 *
 * A long session accumulates tool output that has stopped being useful: a file
 * re-read after an edit, a grep that matched nothing, a command that printed
 * the same three lines four times. None of it is wrong, and all of it is
 * displacing the task. Pruning replaces those results with a fixed notice
 * rather than deleting them, so the transcript still shows that the work
 * happened.
 *
 * ## The four rules, and why each exists
 *
 * **1. Recent output is protected.** The most recent `protectTokens` of tool
 * output stays intact. A model mid-investigation needs what it just fetched;
 * pruning it turns a follow-up question into a re-fetch.
 *
 * **2. Superseded and useless results bypass that protection.** A stale
 * re-read of a file that has since been edited, or a result the tool itself
 * flagged as uninformative, is dead weight at *any* age. Protecting them would
 * mean the very results with the least information are the most expensive.
 *
 * **3. Never prune something whose removal would trigger more work.** A skill
 * read and an artifact recovery read are protected by predicate: eliding an
 * artifact read *mints another artifact read*, so pruning one can produce an
 * unbounded loop. A string matcher protects a tool by name; a predicate sees the
 * paired call and can reason about what a re-run would cost.
 *
 * **4. Never rewrite a warm prompt-cache prefix.** Mutating a message the
 * provider has already cached forces it to re-write everything after it, at the
 * cache-write price. That can cost more than the pruning saves. A result whose
 * all-message suffix exceeds `cacheWarmSuffixTokens` sits in that prefix and is
 * left to compaction, which rebuilds the cache anyway.
 *
 * ## Why the notices are fixed strings
 *
 * `estimatePrunedSavings` compares the replaced text against the notice. A
 * result too short for the notice to be a saving is not pruned at all, because
 * eliding it would cost tokens rather than save them.
 */

import { type AssistantMessage, contentText, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { estimateTokens } from "./compaction.ts";

/** Replaces a result a newer read of the same target has made redundant. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Replaces a result the tool itself flagged as carrying no information. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Below this, pruning cannot pay for the notice that replaces it.
 *
 * Exported because the threshold is part of the contract: a caller choosing a
 * budget needs to know where the floor is.
 */
export const MIN_PRUNE_TOKENS = 8;

/** The result an uninteresting tool call is expected to produce. */
const EMPTY_RESULT_TOKENS = 4;

const SKILL_PREFIX = "skill://";
const ARTIFACT_PREFIX = "artifact://";

/** A tool result paired with the call that produced it. */
export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

/** A tool call, reduced to what protection needs to reason about. */
export interface AgentToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/**
 * A protection rule.
 *
 * A string protects every result from that tool. A predicate sees the paired
 * call, which is what lets a rule ask "would re-running this produce more of
 * the same thing?" - a question the tool name alone cannot answer.
 */
export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

export interface PruneConfig {
	/** Tokens of recent tool output to leave intact. */
	readonly protectTokens: number;
	/** Do not prune unless the total saving reaches this, so churn is not free. */
	readonly minimumSavings: number;
	readonly protectedTools: readonly ProtectedToolMatcher[];
	/**
	 * Maps a tool call to a supersede key. Results sharing a key form a group in
	 * which all but the newest are stale. Returning `undefined` exempts the call.
	 */
	readonly supersedeKey?: SupersedeKeyFn;
	/** Prune results the tool flagged as uninformative. */
	readonly pruneUseless?: boolean;
	/**
	 * A result whose all-message suffix exceeds this sits in the provider's warm
	 * cache prefix; mutating it re-writes the whole suffix. Undefined disables the
	 * guard, which prunes superseded and useless results at any depth.
	 */
	readonly cacheWarmSuffixTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadResult],
	pruneUseless: true,
};

/**
 * Maps a tool call to a supersede key.
 *
 * A key `K` also supersedes keys with prefix `K + "\0"`, so a selector-free read
 * of a path supersedes earlier reads of the same path *with* selectors: the
 * whole-file read is strictly newer information than the partial ones.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

/** Indexes every tool call in the transcript by its id. */
export function collectToolCallsById(messages: readonly Message[]): Map<string, AgentToolCall> {
	const calls = new Map<string, AgentToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type === "toolCall") {
				calls.set(block.id, {
					id: block.id,
					name: block.name,
					arguments: block.arguments as Record<string, unknown>,
				});
			}
		}
	}
	return calls;
}

/** The `path` argument of a paired `read` call, when both halves line up. */
function readPath(context: ProtectedToolContext): string | undefined {
	if (context.toolResult.toolName !== "read" || context.toolCall?.name !== "read") return undefined;
	const path = context.toolCall.arguments.path;
	return typeof path === "string" ? path : undefined;
}

/** A read of a skill's internal URL. */
export function isSkillReadResult(context: ProtectedToolContext): boolean {
	return readPath(context)?.startsWith(SKILL_PREFIX) ?? false;
}

/**
 * A recovery read of a session artifact.
 *
 * Protected because eliding one *mints another*: the model notices the gap and
 * re-reads, producing a fresh artifact, which is also elided. The loop is
 * bounded only by the context window.
 */
export function isArtifactRecoveryResult(context: ProtectedToolContext): boolean {
	if (readPath(context)?.startsWith(ARTIFACT_PREFIX)) return true;
	const details = context.toolResult.details as { meta?: { source?: { type?: string; value?: string } } } | undefined;
	const source = details?.meta?.source;
	return source?.type === "internal" && (source.value?.startsWith(ARTIFACT_PREFIX) ?? false);
}

/** Whether a result is protected by any matcher. */
export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	const context: ProtectedToolContext = { toolResult, toolCall };
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher(context)) return true;
	}
	return false;
}

/** Whether a result carries nothing: empty, whitespace, or an error with no text. */
function isUneventful(message: ToolResultMessage): boolean {
	const text = contentText(message.content);
	if (text.trim().length > 0) return false;
	// An error is never uneventful, however short. "Command not found" is the
	// single most informative thing a failed call can say, and eliding it is how a
	// model loops on the same failure.
	return !message.isError;
}

/** The token saving from replacing `tokens` with `notice`. */
export function estimatePrunedSavings(tokens: number, notice: string): number {
	return tokens - Math.ceil(notice.length / 4);
}

/** The notice for an age-pruned result, sized so the saving is visible. */
function createPrunedNotice(tokens: number): string {
	return `[Tool output elided — about ${tokens} tokens]`;
}

/** Per-index token totals for the whole message, or just the suffix after it. */
function computeMessageSuffixTokens(messages: readonly Message[]): number[] {
	const totals = new Array<number>(messages.length).fill(0);
	let running = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		totals[index] = running;
		running += estimateTokens(messages[index] as AgentMessage);
	}
	return totals;
}

export interface PruneResult {
	readonly prunedCount: number;
	readonly tokensSaved: number;
}

/**
 * A tool result rewritten in place, carrying a marker so a second pass does not
 * re-prune it.
 */
interface PrunableResult {
	readonly message: ToolResultMessage;
	readonly index: number;
	readonly tokens: number;
	readonly notice: string;
	readonly superseded: boolean;
	readonly useless: boolean;
}

/** The `prunedAt` marker, attached without mutating the caller's messages. */
export type MarkedToolResult = ToolResultMessage & { prunedAt?: number };

/** Results already carrying a prune marker. */
function isPruned(message: Message): boolean {
	return (message as MarkedToolResult).prunedAt !== undefined;
}

/**
 * Collects results a newer read of the same target has made redundant.
 *
 * Walks backwards, so the first result seen for a key is the newest and every
 * earlier one is a candidate.
 */
function collectSuperseded(
	messages: readonly Message[],
	calls: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn,
	protectedTools: readonly ProtectedToolMatcher[],
): PrunableResult[] {
	// Exact keys, plus the set of keys that have been superseded by a
	// selector-free read.
	const seenKeys = new Set<string>();
	const candidates: PrunableResult[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult" || isPruned(message)) continue;
		const call = calls.get((message as ToolResultMessage).toolCallId);
		if (!call) continue;
		if (isProtectedToolResult(message as ToolResultMessage, call, protectedTools)) continue;
		const key = supersedeKey(call.name, call.arguments);
		if (key === undefined) continue;
		// A key is superseded when a *later* read produced the same key, or a
		// selector-free read of the same base path. The second case is what keeps
		// a whole-file read from being replaced by a partial one: a partial read is
		// never strictly newer information, so it cannot retire the full copy.
		const separator = key.indexOf("\0");
		if (seenKeys.has(key) || (separator >= 0 && seenKeys.has(key.slice(0, separator)))) {
			candidates.push({
				message: message as ToolResultMessage,
				index,
				tokens: estimateTokens(message as AgentMessage),
				notice: SUPERSEDED_NOTICE,
				superseded: true,
				useless: false,
			});
			continue;
		}
		seenKeys.add(key);
	}
	return candidates;
}

/** Collects results that carry nothing worth the tokens. */
function collectUneventful(
	messages: readonly Message[],
	calls: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	alreadySuperseded: ReadonlySet<Message>,
): PrunableResult[] {
	const candidates: PrunableResult[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult" || isPruned(message)) continue;
		if (alreadySuperseded.has(message)) continue;
		const result = message as ToolResultMessage;
		if (!isUneventful(result)) continue;
		if (isProtectedToolResult(result, calls.get(result.toolCallId), protectedTools)) continue;
		const tokens = estimateTokens(message as AgentMessage);
		// A blank result is only worth pruning if the notice is actually smaller.
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= EMPTY_RESULT_TOKENS) continue;
		candidates.push({
			message: result,
			index,
			tokens,
			notice: USELESS_NOTICE,
			superseded: false,
			useless: true,
		});
	}
	return candidates;
}

/**
 * Prunes tool results from a transcript.
 *
 * Returns a **new** array; the input is never mutated. A transcript is
 * persisted state, and mutating it in place would make a prune impossible to
 * undo and impossible to test against the original.
 */
export function pruneToolOutputs(
	messages: readonly Message[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): { messages: Message[]; prunedCount: number; tokensSaved: number } {
	const calls = collectToolCallsById(messages);

	const superseded = config.supersedeKey
		? collectSuperseded(messages, calls, config.supersedeKey, config.protectedTools)
		: [];
	const supersededMessages = new Set(superseded.map((candidate) => candidate.message as Message));
	const useless =
		config.pruneUseless === false
			? []
			: collectUneventful(messages, calls, config.protectedTools, supersededMessages);

	// A candidate from either collector is exempt from the age-based protection.
	const exempt = new Map<number, PrunableResult>();
	for (const candidate of [...superseded, ...useless]) exempt.set(candidate.index, candidate);

	// Age-based protection: walk backwards accumulating tool-output tokens and
	// leave the most recent `protectTokens` intact.
	const warmGuardArmed = config.cacheWarmSuffixTokens !== undefined;
	const suffix = warmGuardArmed ? computeMessageSuffixTokens(messages) : undefined;
	const additional: PrunableResult[] = [];
	let accumulated = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult") continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (isPruned(message)) {
			accumulated += tokens;
			continue;
		}
		// The cache guard runs before any prune decision, so a superseded or
		// useless result deep in a warm prefix cannot reach here.
		if (suffix && config.cacheWarmSuffixTokens !== undefined && suffix[index]! > config.cacheWarmSuffixTokens) {
			accumulated += tokens;
			continue;
		}
		if (!exempt.has(index)) {
			const call = calls.get((message as ToolResultMessage).toolCallId);
			// A result is kept when any one of three rules says to keep it. They are
			// checked as separate vetoes rather than folded into one condition,
			// because each is independently sufficient: a protected result is never
			// pruned, and a result too small to pay for its own notice is never
			// pruned, regardless of how old it is or how much budget is left.
			const keepProtected = isProtectedToolResult(message as ToolResultMessage, call, config.protectedTools);
			const keepTooSmallToPay = tokens < MIN_PRUNE_TOKENS;
			const keepRecent = accumulated < config.protectTokens;
			if (!keepProtected && !keepTooSmallToPay && !keepRecent) {
				additional.push({
					message: message as ToolResultMessage,
					index,
					tokens,
					notice: createPrunedNotice(tokens),
					superseded: false,
					useless: false,
				});
			}
		}
		accumulated += tokens;
	}

	const all = [...exempt.values(), ...additional];
	const savings = all.reduce(
		(total, candidate) => total + estimatePrunedSavings(candidate.tokens, candidate.notice),
		0,
	);
	// A prune that does not reach the minimum is not worth the churn: it rewrites
	// the prompt and the cache to save almost nothing.
	if (savings < config.minimumSavings) return { messages: [...messages], prunedCount: 0, tokensSaved: 0 };

	const byIndex = new Map(all.map((candidate) => [candidate.index, candidate]));
	const output = messages.map((message, index) => {
		const candidate = byIndex.get(index);
		if (!candidate) return message;
		const pruned: MarkedToolResult = {
			...(message as ToolResultMessage),
			content: [{ type: "text", text: candidate.notice }],
			prunedAt: message.timestamp,
		};
		return pruned as Message;
	});

	return { messages: output, prunedCount: byIndex.size, tokensSaved: savings };
}
