/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */
import { viewportRange } from "../components/scroll-viewport.ts";
import { Text } from "../components/text.ts";
export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: readonly string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

const textCache = new Map<string, Text>();
/** The text each cached entry was built from; `Text` cannot be read back. */
const cachedText = new Map<string, string>();
const TRUNCATE_CACHE_MAX = 8;

function cacheKey(text: string, width: number, paddingX: number): string {
	return `${paddingX} ${width} ${text.length} ${hashText(text)}`;
}

function getCachedText(cacheKeyValue: string, paddingX: number): Text {
	let text = textCache.get(cacheKeyValue);
	if (!text) {
		text = new Text("", paddingX, 0);
		if (textCache.size >= TRUNCATE_CACHE_MAX) textCache.clear();
		textCache.set(cacheKeyValue, text);
	}
	return text;
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Keyed by (text, width, padding): Text caches internally, so a shared
	// single slot thrashes with 2+ live cards at the same padding.
	const key = cacheKey(text, width, paddingX);
	const tempText = getCachedText(key, paddingX);
	// Prime Pi's `Text` can be set but not read back, so the text each cached entry was built
	// from is tracked beside it rather than round-tripped through the component.
	if (cachedText.get(key) !== text) {
		cachedText.set(key, text);
		tempText.setText(text);
	}
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// Take the last N visual lines
	const range = viewportRange(allVisualLines.length, maxVisualLines, allVisualLines.length);
	const truncatedLines = allVisualLines.slice(range.start, range.end);

	return { visualLines: truncatedLines, skippedCount: range.start };
}

/**
 * Stable hash for a truncation cache key.
 *
 * The reference uses `Bun.hash`. This key only has to be stable within a process, so FNV-1a
 * serves; the value is never persisted or compared against the reference's.
 */
function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}
