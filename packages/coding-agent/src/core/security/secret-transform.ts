/**
 * Message-level redaction, applied to the provider projection only.
 *
 * ## The invariant this file exists to protect
 *
 * `redactMessages` returns **new** message objects and never mutates its input.
 * The stored session is the canonical record; the projection is a derived view
 * rebuilt on every request. Redacting the view leaves the record — and therefore
 * provenance, resume behaviour, and the operator's own history — untouched.
 *
 * A design that rewrote stored entries to remove a secret would be destructive in
 * a way that is hard to undo and easy to miss: the entry would still claim to be
 * the thing the user typed, but would no longer be. Worse, a redaction that
 * touched the record would have to be re-applied to already-redacted history on
 * the next run, which is exactly the non-idempotence this file avoids.
 *
 * ## Why role matters
 *
 * Only roles that can carry user- or tool-authored text are walked. System
 * prompts and static tool schemas are skipped deliberately: redacting them would
 * corrupt the prompt prefix, break provider-side prompt caching, and gain
 * nothing, because Pi does not put credentials there.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SecretRedactor } from "./secrets.ts";

/** Text-bearing content blocks we know how to walk. */
type TextBlock = TextContent | ImageContent;

/**
 * Whether a message can contain text a secret might have leaked into.
 *
 * Assistant messages are included: the model echoes file contents and command
 * output, so a secret read earlier can reappear there.
 */
function isRedactableMessage(message: AgentMessage): boolean {
	const role = (message as { role?: string }).role;
	return role === "user" || role === "assistant" || role === "toolResult" || role === "custom";
}

/**
 * Redacts the text blocks of a single content array.
 *
 * Returns the original array when nothing changed, which is what lets callers
 * use reference equality to skip downstream work — and, more importantly, what
 * makes the transform observably a no-op on clean input.
 */
function redactContent<T extends TextBlock>(content: readonly T[], redactor: SecretRedactor): T[] {
	let changed = false;
	const next = content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const redacted = redactor.redact(block.text);
		if (redacted === block.text) return block;
		changed = true;
		return { ...block, text: redacted };
	});
	return changed ? (next as T[]) : (content as T[]);
}

/** Redacts a tool result, including the structured `details` payload. */
function redactToolResult(message: ToolResultMessage, redactor: SecretRedactor): ToolResultMessage | undefined {
	const content = redactContent(message.content, redactor);
	const details = redactDetails(message.details, redactor);
	if (content === message.content && details === message.details) return undefined;
	return { ...message, content, details } as ToolResultMessage;
}

/**
 * Redacts inside an arbitrary structured payload.
 *
 * Depth and breadth are bounded: a tool result can carry an object graph of
 * unbounded size, and a cycle would make a naive walk hang. Unknown non-plain
 * values are passed through untouched rather than guessed at, because guessing
 * at a class instance's internals is how a redactor ends up corrupting data.
 */
function redactDetails(details: unknown, redactor: SecretRedactor, depth = 0): unknown {
	if (depth > 8) return details;
	if (typeof details === "string") return redactor.redact(details);
	if (Array.isArray(details)) {
		let changed = false;
		const next = details.map((entry) => {
			const redacted = redactDetails(entry, redactor, depth + 1);
			if (redacted !== entry) changed = true;
			return redacted;
		});
		return changed ? next : details;
	}
	if (details && typeof details === "object") {
		const prototype = Object.getPrototypeOf(details);
		// Only plain objects are walked. A class instance may hold a file handle,
		// a socket, or a cycle, and copying it would be worse than leaving it.
		if (prototype !== Object.prototype && prototype !== null) return details;
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
			const redacted = redactDetails(value, redactor, depth + 1);
			if (redacted !== value) changed = true;
			next[key] = redacted;
		}
		return changed ? next : details;
	}
	return details;
}

/**
 * Redacts a message list for provider-bound use.
 *
 * Returns the **same array reference** when nothing needed redacting, so a clean
 * session takes an identity path and pays nothing.
 */
export function redactMessages<T extends AgentMessage>(messages: readonly T[], redactor: SecretRedactor): T[] {
	if (redactor.isEmpty) return messages as T[];

	let changed = false;
	const next: T[] = [];

	for (const message of messages) {
		if (!isRedactableMessage(message)) {
			next.push(message);
			continue;
		}

		if ((message as { role?: string }).role === "toolResult") {
			const redacted = redactToolResult(message as ToolResultMessage, redactor);
			if (redacted) {
				changed = true;
				next.push(redacted as T);
				continue;
			}
			next.push(message);
			continue;
		}

		const typed = message as unknown as { content?: readonly TextBlock[]; details?: unknown; isError?: boolean };
		if (!Array.isArray(typed.content)) {
			next.push(message);
			continue;
		}
		const content = redactContent(typed.content, redactor);
		const details = redactDetails(typed.details, redactor);
		if (content === typed.content && details === typed.details) {
			next.push(message);
			continue;
		}
		changed = true;
		next.push({ ...typed, content, details } as T);
	}

	return changed ? next : (messages as T[]);
}

/**
 * Restores secrets in tool arguments immediately before execution.
 *
 * This is the only place `restore` belongs on the inbound path. The result is
 * handed to the tool and never persisted, so a placeholder in the transcript
 * stays a placeholder and the tool still sees the real value.
 */
export function restoreToolArguments<T>(args: T, redactor: SecretRedactor): T {
	if (!args || typeof args !== "object") {
		return typeof args === "string" ? (redactor.restore(args) as T) : args;
	}
	if (Array.isArray(args)) {
		return args.map((entry) => restoreToolArguments(entry, redactor)) as T;
	}
	const prototype = Object.getPrototypeOf(args as object);
	if (prototype !== Object.prototype && prototype !== null) return args;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		next[key] = restoreToolArguments(value, redactor);
	}
	return next as T;
}

/**
 * A last-resort check before content leaves the machine.
 *
 * Returns the offending values' presence rather than the values themselves, so a
 * caller can log "this payload was not sent" without logging why.
 */
export function findSecretLeak(text: string, redactor: SecretRedactor): boolean {
	return redactor.containsSecret(text);
}
