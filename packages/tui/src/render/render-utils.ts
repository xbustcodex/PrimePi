/**
 * Status icons for the render layer.
 *
 * Ported from the reference's `render-utils.ts`, which is ~900 lines of render helpers. Only
 * `formatStatusIcon` is needed by what is mounted so far, so only it is here: bringing the rest
 * would be a port with no consumer, which is the failure this whole work is correcting.
 *
 * The mapping is the point of the function - one place that decides which glyph and which
 * colour means running, succeeded, failed - so two surfaces cannot disagree about it.
 */

import type { ThemeSource } from "../theme/active-theme.ts";

/** The states the render layer distinguishes. */
export type ToolUIStatus = "pending" | "running" | "success" | "done" | "error" | "warning" | "info";

/** Symbol key and colour token for each status. */
const STATUS_GLYPHS: Readonly<
	Record<
		ToolUIStatus,
		{ readonly symbol: string; readonly color: "success" | "error" | "warning" | "accent" | "muted" }
	>
> = {
	success: { symbol: "status.success", color: "success" },
	done: { symbol: "status.done", color: "success" },
	error: { symbol: "status.error", color: "error" },
	warning: { symbol: "status.warning", color: "warning" },
	info: { symbol: "status.info", color: "accent" },
	pending: { symbol: "status.pending", color: "muted" },
	running: { symbol: "status.running", color: "accent" },
};

/**
 * The glyph for a status, in the colour that status implies.
 *
 * `running` and `pending` take a spinner frame when one is supplied, so a running tool shows
 * motion rather than a static glyph.
 */
export function formatStatusIcon(status: ToolUIStatus, theme: ThemeSource, spinnerFrame?: number): string {
	const entry = STATUS_GLYPHS[status];
	if (status === "running" && spinnerFrame !== undefined) {
		const frames = theme.symbol("spinner.frames");
		const frame = typeof frames === "string" ? frames[spinnerFrame % frames.length] : undefined;
		if (frame !== undefined) return theme.fg(entry.color, frame);
	}
	return theme.fg(entry.color, theme.symbol(entry.symbol));
}
