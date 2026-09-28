/**
 * The session's auto-recall and auto-retain lifecycle.
 *
 * ## Why this is separate from the pipeline
 *
 * `MemoryService` decides *what* is worth remembering and what to return. This
 * module decides *when* those operations happen in a session's life, which is a
 * different question with different failure modes: a lifecycle that fires twice
 * per turn duplicates memory, and one that never fires is invisible until
 * someone notices recall returning nothing.
 *
 * ## The two invariants
 *
 * **Recall happens at most once per user turn.** The first prompt of a turn
 * carries context; the rest of the turn is the same conversation continuing, and
 * re-recalling on every message would both cost a store round trip and put the
 * same block into the prompt repeatedly. A generation counter guards the
 * commit, so a recall whose result arrives after a newer one started is
 * discarded rather than applied out of order.
 *
 * **Retain advances a cursor, not a flag.** Counting user turns and retaining
 * everything since the last cursor means a turn is retained exactly once, even
 * if the lifecycle is invoked more than once. A boolean would either lose turns
 * or duplicate them.
 *
 * ## Why the query keeps the latest prompt intact
 *
 * A recall query is built from prior context plus the current prompt, then
 * truncated to a budget. Truncation drops *oldest context first* and always
 * preserves the latest prompt, because a query missing the current question
 * recalls memories about the wrong thing — which is worse than recalling
 * nothing, since the model cannot tell the difference.
 */

import type { MemoryQuery } from "./backend.ts";
import type { MemoryContext } from "./context.ts";
import type { WorkEvent } from "./retention.ts";
import type { SessionMemory } from "./session.ts";

/** The marker that separates prior context from the current question. */
const CONTEXT_MARKER = "Prior context:";

/** A message in a conversation, reduced to what recall needs. */
export interface ConversationMessage {
	readonly role: "user" | "assistant" | "system";
	readonly content: string;
}

export interface AutoMemoryOptions {
	/** Recall on the first prompt of each user turn. */
	readonly autoRecall: boolean;
	/** Retain conversation content as it accumulates. */
	readonly autoRetain: boolean;
	/** How many user turns of prior context join the recall query. */
	readonly recallContextTurns: number;
	/** Hard cap on the composed query. */
	readonly recallMaxQueryChars: number;
	/** Retain after this many user turns. 1 means every turn. */
	readonly retainEveryNTurns: number;
	/** Characters for the injected block. */
	readonly injectionBudget?: number;
}

export const DEFAULT_AUTO_MEMORY: AutoMemoryOptions = {
	autoRecall: true,
	autoRetain: true,
	recallContextTurns: 2,
	recallMaxQueryChars: 2_000,
	retainEveryNTurns: 1,
};

/**
 * The last N user-bounded turns.
 *
 * Slicing on a *user* boundary rather than a message count is what keeps a turn
 * whole. Slicing by count can start a window mid-exchange, and a recall query
 * built from half a prior turn is a query about something the user was never
 * asking.
 *
 * Returns the whole list when there are fewer user turns than requested, rather
 * than an empty slice - asking for more context than exists should degrade to
 * all of it.
 */
export function sliceLastTurnsByUserBoundary(
	messages: readonly ConversationMessage[],
	turns: number,
): ConversationMessage[] {
	if (messages.length === 0 || turns <= 0) return [];
	let seen = 0;
	let start = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]!.role === "user") {
			seen += 1;
			if (seen >= turns) {
				start = index;
				break;
			}
		}
	}
	return start === -1 ? [...messages] : messages.slice(start);
}

/** Wraps content in the role markers recall uses, matching the reference. */
function lineFor(message: ConversationMessage): string | undefined {
	const content = stripMemoryBlocks(message.content).trim();
	if (!content) return undefined;
	return `${message.role}: ${content}`;
}

/**
 * Removes memory-injection blocks from text about to become a recall query.
 *
 * A memory block echoed back into a query would be treated as the user's own
 * words on the next turn, so a retrieved memory could speak as the user. That
 * is the injection path this whole architecture closes.
 */
export function stripMemoryBlocks(text: string): string {
	return text
		.replace(/<memories>[\s\S]*?<\/memories>/gi, "")
		.replace(/<mental_models>[\s\S]*?<\/mental_models>/gi, "")
		.replace(/<memory>[\s\S]*?<\/memory>/gi, "");
}

/**
 * Composes a recall query from the current prompt plus prior context.
 *
 * The current prompt is always last, and never duplicated: repeating it inside
 * the context block would let it satisfy a query term twice and skew ranking.
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: readonly ConversationMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;
	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const lines: string[] = [];
	for (const message of contextual) {
		if (message.role === "user" && stripMemoryBlocks(message.content).trim() === latest) continue;
		const line = lineFor(message);
		if (line) lines.push(line);
	}
	if (lines.length === 0) return latest;
	return [`${CONTEXT_MARKER}`, lines.join("\n"), latest].join("\n\n");
}

/**
 * Truncates a composed query to a budget, preserving the current prompt.
 *
 * Oldest context is dropped first, because the current question is what the
 * recall is *for*. If even the prompt alone exceeds the budget it is sliced,
 * since returning nothing would look like "no relevant memories" and hide a
 * query that simply needed trimming.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;
	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;
	const header = `${CONTEXT_MARKER}\n\n`;
	if (!query.includes(header)) return latestOnly;
	const headerIndex = query.indexOf(header);
	if (headerIndex === -1) return latestOnly;
	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;
	const body = query.slice(headerIndex + header.length, suffixIndex);
	const lines = body.split("\n").filter(Boolean);
	const kept: string[] = [];
	for (let index = lines.length - 1; index >= 0; index--) {
		kept.unshift(lines[index]!);
		if (`${header}${kept.join("\n")}${suffix}`.length > maxChars) {
			kept.shift();
			break;
		}
	}
	return kept.length > 0 ? `${header}${kept.join("\n")}${suffix}` : latestOnly;
}

/** What a recall produced, plus whether it should still be applied. */
export interface PreparedRecall {
	/**
	 * Applies the result, unless a newer recall started first.
	 *
	 * Returns false when superseded. A recall is a network round trip against a
	 * store, so a slow one can easily land after a fast one for a later turn;
	 * applying it would put the earlier turn's memory into the later turn's prompt.
	 */
	commit(): boolean;
	/** Runs the recall. Separate from commit so a caller can abandon the turn. */
	run(): Promise<MemoryContext>;
}

/**
 * The auto-recall / auto-retain lifecycle for one session.
 *
 * One instance per session. It holds no state beyond two cursors, and every
 * method is safe to call when memory is inert.
 */
export class AutoMemoryLifecycle {
	readonly #memory: SessionMemory;
	readonly #options: AutoMemoryOptions;
	#recalledThisTurn = false;
	/** User turns retained so far. The cursor is what makes retention exactly-once. */
	#retainedTurns = 0;
	#recallGeneration = 0;

	constructor(memory: SessionMemory, options: Partial<AutoMemoryOptions> = {}) {
		this.#memory = memory;
		this.#options = { ...DEFAULT_AUTO_MEMORY, ...options };
	}

	get options(): AutoMemoryOptions {
		return this.#options;
	}

	/** True when the next turn boundary will retain. Useful for a status line. */
	get pendingRetain(): boolean {
		return this.#options.autoRetain && this.#needsRetain(0);
	}

	#needsRetain(additionalUserTurns: number): boolean {
		return this.#retainedTurns + additionalUserTurns >= this.#options.retainEveryNTurns;
	}

	/**
	 * Prepares recall for a prompt, at most once per user turn.
	 *
	 * Returns `undefined` when recall is off, when this turn already recalled,
	 * or when the prompt is empty. All three are ordinary, not errors.
	 */
	prepareRecall(promptText: string, messages: readonly ConversationMessage[] = []): PreparedRecall | undefined {
		if (!this.#options.autoRecall) return undefined;
		if (this.#recalledThisTurn) return undefined;
		const latest = promptText.trim();
		if (!latest) return undefined;

		const generation = ++this.#recallGeneration;
		const composed = composeRecallQuery(latest, messages, this.#options.recallContextTurns);
		const query: MemoryQuery = { text: truncateRecallQuery(composed, latest, this.#options.recallMaxQueryChars) };
		// Captured before the literal: `this` inside an object method is the object,
		// not the lifecycle, so the dependencies have to be bound here.
		const memory = this.#memory;
		const budget = this.#options.injectionBudget;
		return {
			commit: () => {
				if (this.#recallGeneration !== generation) return false;
				this.#recalledThisTurn = true;
				return true;
			},
			async run() {
				return memory.contextFor(query, {}, budget);
			},
		};
	}

	/**
	 * Marks the user turn as consumed for recall purposes.
	 *
	 * Called once the assistant has responded. Kept separate from `prepareRecall`
	 * so a turn that never produced a response does not silently suppress the
	 * next turn's recall.
	 */
	endTurn(): void {
		this.#recalledThisTurn = false;
	}

	/**
	 * Retains conversation content, if a whole number of turns has accumulated.
	 *
	 * The cursor advances only when retention actually runs, so a store failure
	 * does not consume the turns it failed to store. Silently advancing past a
	 * failure would lose exactly the content that was worth keeping.
	 */
	async maybeRetain(messages: readonly ConversationMessage[]): Promise<{ retained: number; skipped: boolean }> {
		if (!this.#options.autoRetain) return { retained: 0, skipped: true };
		const userTurns = messages.filter((message) => message.role === "user").length;
		if (!this.#needsRetain(userTurns - this.#retainedTurns)) return { retained: 0, skipped: true };
		// The unretained window: from the first message after the last cursor.
		const window = messages.slice(this.#retainedTurns);
		// Offered as a transcript; the retention policy extracts facts from it and
		// does not store it whole. `storeTranscripts` is off by default and stays off.
		const event: WorkEvent = {
			type: "edit",
			text: window.map((message) => `${message.role}: ${stripMemoryBlocks(message.content)}`).join("\n"),
			origin: { agent: "session", source: "auto-retain" },
		};
		await this.#memory.retain(event);
		this.#retainedTurns = messages.length;
		return { retained: window.length, skipped: false };
	}
}

/** Prepares recall and applies it in one call, for callers that need no deferral. */
export async function recallForTurn(
	lifecycle: AutoMemoryLifecycle,
	promptText: string,
	messages: readonly ConversationMessage[] = [],
): Promise<MemoryContext | undefined> {
	const prepared = lifecycle.prepareRecall(promptText, messages);
	if (!prepared) return undefined;
	const context = await prepared.run();
	// Commit only after the fact, so a caller that awaits this always gets its
	// memory and the once-per-turn rule still holds.
	prepared.commit();
	return context;
}
