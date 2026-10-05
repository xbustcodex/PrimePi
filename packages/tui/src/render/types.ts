/**
 * Shared types for TUI rendering components.
 */
import type { Theme } from "../theme/index.ts";

/** Visual state of a rendered tool output. */
export type State = "pending" | "running" | "success" | "error" | "warning";

/** Position and theme context passed to tree item renderers. */
export interface TreeContext {
	index: number;
	isLast: boolean;
	depth: number;
	theme: Theme;
	prefix: string;
	continuePrefix: string;
	/** Maximum rendered branch/continuation prefix width reserved during pre-rendering. */
	prefixWidth?: number;
}
