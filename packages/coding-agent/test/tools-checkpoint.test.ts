import { describe, expect, it } from "vitest";
import { CheckpointController } from "../src/core/tools/checkpoint.ts";

/**
 * Checkpoint and rewind.
 *
 * The properties that matter: a rewind **requires a written report**, because the
 * report is the only thing that survives; and a second checkpoint is refused
 * rather than nested, because nested checkpoints have no coherent rewind target.
 */

const NOW = 1_700_000_000_000;

function controller(): CheckpointController {
	return new CheckpointController();
}

describe("taking a checkpoint", () => {
	it("records the goal and the session position", () => {
		const c = controller();
		const outcome = c.checkpoint({ goal: "find the retry policy", nowMs: NOW, messageCount: 12, entryId: "e5" });
		expect(outcome.ok).toBe(true);
		expect(c.active?.goal).toBe("find the retry policy");
		expect(c.active?.checkpointMessageCount).toBe(12);
		expect(c.active?.checkpointEntryId).toBe("e5");
	});

	it("refuses a second checkpoint rather than nesting one", () => {
		// Rewinding to the inner discards the outer work; rewinding to the outer
		// discards the inner's. There is no coherent target, so it is an error.
		const c = controller();
		c.checkpoint({ goal: "first", nowMs: NOW, messageCount: 1, entryId: "a" });
		const second = c.checkpoint({ goal: "second", nowMs: NOW, messageCount: 2, entryId: "b" });
		expect(second.ok).toBe(false);
		expect(second.ok === false && second.reason).toContain("already active");
		expect(c.active?.goal).toBe("first");
	});

	it("refuses a checkpoint with no goal", () => {
		// A checkpoint that records nothing about what was being explored leaves the
		// rewind with no context to report against.
		const c = controller();
		expect(c.checkpoint({ goal: "   ", nowMs: NOW, messageCount: 1, entryId: null }).ok).toBe(false);
	});
});

describe("rewinding requires a written report", () => {
	it("keeps the report, which is the only thing that survived", () => {
		const c = controller();
		c.checkpoint({ goal: "find the retry policy", nowMs: NOW, messageCount: 12, entryId: "e5" });
		const outcome = c.rewind({ report: "The retry budget comes from retry.maxRetries", nowMs: NOW + 1000 });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.state.report).toContain("retry.maxRetries");
		expect(outcome.message).toContain("Findings kept");
	});

	it("refuses an empty report", () => {
		// Named explicitly, because a rewind with an empty report looks successful
		// and silently discards the exploration.
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 1, entryId: null });
		const outcome = c.rewind({ report: "   ", nowMs: NOW });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("empty-report");
		// The checkpoint survives, so the model can write the report and retry.
		expect(c.active).toBeDefined();
	});

	it("refuses a rewind with no checkpoint", () => {
		const outcome = controller().rewind({ report: "findings", nowMs: NOW });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe("no-checkpoint");
	});

	it("clears the checkpoint once rewound", () => {
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 1, entryId: null });
		c.rewind({ report: "findings", nowMs: NOW });
		expect(c.active).toBeUndefined();
		// And the completed rewind is retained for the session to report.
		expect(c.lastRewind?.report).toBe("findings");
	});

	it("allows a fresh checkpoint after a rewind", () => {
		const c = controller();
		c.checkpoint({ goal: "first", nowMs: NOW, messageCount: 1, entryId: null });
		c.rewind({ report: "findings", nowMs: NOW });
		expect(c.checkpoint({ goal: "second", nowMs: NOW, messageCount: 1, entryId: null }).ok).toBe(true);
	});
});

describe("the rejoin target is an entry id, not an index", () => {
	it("names the entry rather than a message offset", () => {
		// An index into a mutable array drifts as entries are added or pruned, and a
		// drifted rejoin is a rewind to the wrong place.
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 40, entryId: "entry-40" });
		expect(c.rejoinTarget()).toBe("entry-40");
	});

	it("has no target when the session has no tree", () => {
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 1, entryId: null });
		expect(c.rejoinTarget()).toBeNull();
	});

	it("has no target once rewound", () => {
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 1, entryId: "e1" });
		c.rewind({ report: "findings", nowMs: NOW });
		expect(c.rejoinTarget()).toBeNull();
	});
});

describe("abandoning a checkpoint", () => {
	it("discards it without a rewind", () => {
		const c = controller();
		c.checkpoint({ goal: "investigate", nowMs: NOW, messageCount: 1, entryId: null });
		expect(c.abandon()).toBe(true);
		expect(c.active).toBeUndefined();
		// No rewind happened, so nothing is reported as kept.
		expect(c.lastRewind).toBeUndefined();
	});

	it("reports nothing to abandon when there is none", () => {
		expect(controller().abandon()).toBe(false);
	});
});
