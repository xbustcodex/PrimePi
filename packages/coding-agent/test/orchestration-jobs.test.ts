import { describe, expect, it } from "vitest";
import { isTerminalJobState, JobManager } from "../src/core/orchestration/job-manager.ts";

/**
 * The background job substrate and the Phase 4 association rule.
 *
 * The association tests are the important ones: Phase 4's invariant is that no
 * code path mutates plan, goal, or todo state from elsewhere, and a task is
 * exactly the kind of "elsewhere" that could quietly break it.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = () => Promise.resolve();

describe("background jobs", () => {
	it("returns a stable id immediately and reports running", () => {
		const jobs = new JobManager();
		const gate = deferred();
		const handle = jobs.start("long job", async () => {
			await gate.promise;
			return "finished";
		});

		expect(handle.id).toMatch(/^job-\d+$/);
		expect(jobs.status(handle.id)?.state).toBe("running");
		expect(jobs.runningCount).toBe(1);
		gate.resolve();
	});

	it("never recycles an id", async () => {
		const jobs = new JobManager();
		const first = jobs.start("a", async () => "x");
		await first.wait();
		const second = jobs.start("b", async () => "y");
		await second.wait();
		expect(second.id).not.toBe(first.id);
	});

	it("resolves wait on completion and records the result once", async () => {
		const jobs = new JobManager();
		const handle = jobs.start("j", async () => "the answer");
		expect(await handle.wait()).toBe("completed");
		expect(jobs.status(handle.id)?.result).toBe("the answer");
	});

	it("reports a failure as a value, not a rejection", async () => {
		const jobs = new JobManager();
		const handle = jobs.start("j", async () => {
			throw new Error("boom");
		});
		expect(await handle.wait()).toBe("failed");
		expect(jobs.status(handle.id)?.error).toContain("boom");
	});

	it("cancellation propagates into the running work", async () => {
		const jobs = new JobManager();
		let sawAbort = false;
		const entered = deferred();
		const handle = jobs.start("j", async ({ signal }) => {
			entered.resolve();
			const aborted = deferred();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			sawAbort = signal.aborted;
			return "should not count";
		});

		await entered.promise;
		expect(handle.cancel()).toBe(true);
		expect(await handle.wait()).toBe("cancelled");
		expect(sawAbort).toBe(true);
		expect(jobs.status(handle.id)?.result).toBeUndefined();
	});

	it("cancelling a settled job is inert", async () => {
		const jobs = new JobManager();
		const handle = jobs.start("j", async () => "x");
		await handle.wait();
		expect(handle.cancel()).toBe(false);
	});

	it("cancelAll settles every running job and returns their ids", async () => {
		const jobs = new JobManager();
		const entered = deferred();
		let count = 0;
		const handles = [0, 1].map(() =>
			jobs.start("j", async ({ signal }) => {
				count += 1;
				if (count === 2) entered.resolve();
				const aborted = deferred();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return "x";
			}),
		);
		await entered.promise;

		const cancelled = jobs.cancelAll();
		expect(cancelled).toHaveLength(2);
		expect(jobs.runningCount).toBe(0);
		expect(await Promise.all(handles.map((h) => h.wait()))).toEqual(["cancelled", "cancelled"]);
	});

	it("a result is delivered exactly once", async () => {
		const jobs = new JobManager();
		const handle = jobs.start("j", async () => "once");
		await handle.wait();
		expect(jobs.markDelivered(handle.id)).toBe(true);
		expect(jobs.markDelivered(handle.id)).toBe(false);
	});

	it("refuses work past the running limit", () => {
		const jobs = new JobManager({ maxRunning: 1 });
		const gate = deferred();
		jobs.start("first", async () => {
			await gate.promise;
			return "x";
		});
		expect(() => jobs.start("second", async () => "y")).toThrow(/limit reached/i);
		gate.resolve();
	});

	it("forgets a terminal job but not a running one", async () => {
		const jobs = new JobManager();
		const gate = deferred();
		const running = jobs.start("j", async () => {
			await gate.promise;
			return "x";
		});
		expect(jobs.forget(running.id)).toBe(false);
		gate.resolve();
		await running.wait();
		expect(jobs.forget(running.id)).toBe(true);
	});

	it("recognizes every terminal state", () => {
		for (const state of ["completed", "failed", "cancelled"] as const) {
			expect(isTerminalJobState(state)).toBe(true);
		}
		expect(isTerminalJobState("running")).toBe(false);
	});

	it("waitForAll resolves to every terminal state", async () => {
		const jobs = new JobManager();
		jobs.start("a", async () => "x");
		jobs.start("b", async () => {
			throw new Error("no");
		});
		expect(await jobs.waitForAll()).toEqual(["completed", "failed"]);
		for (let i = 0; i < 5; i++) await tick();
	});
});
