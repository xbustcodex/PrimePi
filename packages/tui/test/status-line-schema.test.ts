import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTEXT_LINE_MODES,
	CUSTOM_STATUS_LINE_DEFAULTS,
	describeContextLine,
	isStatusLineSegmentId,
	modeShowsNumbers,
	resolveContextGauge,
	STATUS_LINE_SEGMENT_IDS,
	validateSegments,
} from "../src/status-line/schema.ts";

/**
 * The status line.
 *
 * Two properties carry this module. **The segment catalog is closed**, so a
 * typo in a hand-edited custom line is a validation error rather than a blank
 * gap with nothing to explain it. And the **boundary ticks are computed** from
 * the session's own triggers, because a tick marking a hard-coded percentage
 * marks the wrong thing on a model with a different one - and a tick that lies
 * is worse than no tick.
 */

describe("the segment catalog is closed", () => {
	it("recognises every catalogued segment", () => {
		for (const id of STATUS_LINE_SEGMENT_IDS) assert.equal(isStatusLineSegmentId(id), true, id);
	});

	it("rejects a segment that is not catalogued", () => {
		assert.equal(isStatusLineSegmentId("modle"), false);
		assert.equal(isStatusLineSegmentId(""), false);
	});

	it("reports every unknown segment, not just the first", () => {
		// A hand-edited line usually has the same mistake in two places, and fixing
		// them one run at a time is the tedious version of this.
		const result = validateSegments({ left: ["modle", "gitt"], right: ["session_name", "costt"] });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.deepEqual(result.unknown, ["modle", "gitt", "costt"]);
	});

	it("accepts a well-formed line", () => {
		const result = validateSegments({ left: ["model", "path"], right: ["cost"] });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.left, ["model", "path"]);
	});

	it("starts a custom line from segments that all exist", () => {
		for (const id of [...CUSTOM_STATUS_LINE_DEFAULTS.left, ...CUSTOM_STATUS_LINE_DEFAULTS.right]) {
			assert.equal(isStatusLineSegmentId(id), true, id);
		}
	});
});

describe("the context gauge", () => {
	const usage = { used: 70_000, window: 100_000 };

	it("fills in `percentage` and shows the number", () => {
		const gauge = resolveContextGauge("percentage", usage);
		assert.equal(gauge.used, 0.7);
		assert.equal(gauge.percent, 70);
		// No ticks: a plain fill carries no boundary information, and drawing ticks a
		// user cannot see the effect of would be decoration.
		assert.deepEqual(gauge.ticks, []);
	});

	it("draws no ticks in `off`, and still reports honestly", () => {
		const gauge = resolveContextGauge("off", usage);
		assert.equal(gauge.ticks.length, 0);
		assert.equal(gauge.percent, 70);
	});

	it("annotates the two boundaries in `annotated`", () => {
		// At 70% the line looks the same whether the next message compacts or not,
		// which is the whole reason annotated exists.
		const gauge = resolveContextGauge("annotated", usage);
		assert.deepEqual(
			gauge.ticks.map((tick) => tick.kind),
			["speculative", "compaction"],
		);
		assert.equal(gauge.ticks[0]!.at, 0.8);
		assert.equal(gauge.ticks[1]!.at, 0.9);
	});

	it("uses the session's own boundaries, not fixed numbers", () => {
		// A hard-coded tick marks the wrong thing on a model with a different
		// trigger, and a tick that lies is worse than no tick.
		const gauge = resolveContextGauge("annotated", { ...usage, speculativeFraction: 0.5, compactionFraction: 0.6 });
		assert.equal(gauge.ticks[0]!.at, 0.5);
		assert.equal(gauge.ticks[1]!.at, 0.6);
	});

	it("emits ticks in ascending order so a renderer need not sort", () => {
		const gauge = resolveContextGauge("annotated", { ...usage, speculativeFraction: 0.95, compactionFraction: 0.5 });
		assert.ok(gauge.ticks[0]!.at < gauge.ticks[1]!.at);
	});

	it("omits a tick outside the window, which could not be drawn", () => {
		const gauge = resolveContextGauge("annotated", { ...usage, speculativeFraction: 1.2, compactionFraction: 0.9 });
		assert.deepEqual(
			gauge.ticks.map((tick) => tick.kind),
			["compaction"],
		);
	});

	it("clamps a used fraction above one", () => {
		assert.equal(resolveContextGauge("percentage", { used: 200_000, window: 100_000 }).used, 1);
		assert.equal(resolveContextGauge("percentage", { used: 200_000, window: 100_000 }).percent, 100);
	});

	it("reads an unconfigured window as empty rather than full", () => {
		// Dividing by zero would report a nonsensical percentage.
		const gauge = resolveContextGauge("percentage", { used: 1_000, window: 0 });
		assert.equal(gauge.used, 0);
		assert.equal(gauge.percent, 0);
	});

	it("shows the same fill in every mode that draws one", () => {
		const filled = CONTEXT_LINE_MODES.filter((mode) => mode !== "off").map(
			(mode) => resolveContextGauge(mode, usage).used,
		);
		assert.deepEqual(new Set(filled), new Set([0.7]));
	});
});

describe("which modes show numbers", () => {
	it("says which ones do", () => {
		assert.equal(modeShowsNumbers("off"), false);
		assert.equal(modeShowsNumbers("percentage"), true);
		assert.equal(modeShowsNumbers("annotated"), true);
		assert.equal(modeShowsNumbers("embedded"), true);
	});

	it("describes the ticks rather than just the fill", () => {
		assert.ok(describeContextLine("annotated").includes("speculative"));
		assert.ok(describeContextLine("off").includes("no context feedback"));
	});
});
