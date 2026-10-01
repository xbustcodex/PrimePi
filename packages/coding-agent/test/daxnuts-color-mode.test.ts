import { setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaxnutsComponent } from "../src/modes/interactive/components/daxnuts.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TRUTHY_TICK_MS = 80;
const ANIMATION_TICKS = 25;

describe("DaxnutsComponent color mode", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Renders the component's final frame, where the whole pre-rendered image is on
	 * screen, under the given terminal color depth.
	 */
	function renderFinalFrame(trueColor: boolean): string {
		setCapabilities({ images: null, trueColor, hyperlinks: false });
		initTheme("dark");
		vi.useFakeTimers();
		const component = new DaxnutsComponent({ requestRender: vi.fn() } as unknown as TUI);
		try {
			vi.advanceTimersByTime(ANIMATION_TICKS * TRUTHY_TICK_MS);
			return component.render(80).join("\n");
		} finally {
			component.dispose();
		}
	}

	it("emits 256-color escapes on a terminal without truecolor", () => {
		const rendered = renderFinalFrame(false);
		expect(rendered).toContain("\x1b[38;5;");
		expect(rendered).toContain("\x1b[48;5;");
		expect(rendered).not.toContain("\x1b[38;2;");
		expect(rendered).not.toContain("\x1b[48;2;");
	});

	it("emits truecolor escapes when the terminal supports them", () => {
		const rendered = renderFinalFrame(true);
		expect(rendered).toContain("\x1b[38;2;");
		expect(rendered).toContain("\x1b[48;2;");
		expect(rendered).not.toContain("\x1b[38;5;");
	});
});
