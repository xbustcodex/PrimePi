import type { FormFieldTheme } from "../components/form.ts";
import { requireActiveTheme } from "../theme/active-theme.ts";

// Resolved inside each styler rather than at module load: this module is imported through the
// package index, so an eager `requireActiveTheme()` would demand a theme from every consumer,
// including tests that never render one.
const theme = () => requireActiveTheme();

/** Shared accent form-field theme used by overlay dialogs. */
export const formTheme: FormFieldTheme = {
	label: (text) => {
		const active = theme();
		return active.bold(active.fg("accent", text));
	},
	description: (text) => theme().fg("muted", text),
	error: (text) => theme().fg("error", text),
	hint: (text) => theme().fg("dim", text),
};
