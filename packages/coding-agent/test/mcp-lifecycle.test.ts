import { describe, expect, it } from "vitest";
import {
	type DebounceOptions,
	injectionEnabled,
	isStartupComplete,
	NotificationDebouncer,
	reportStartup,
} from "../src/core/mcp/lifecycle.ts";

/**
 * MCP lifecycle.
 *
 * The properties that matter: a server that failed is **reported** rather than
 * silently skipped, and a burst of updates injects the state that is current
 * when the user next reads, not the state that arrived first.
 */

let clock = 0;
const now = () => clock;

describe("the startup window", () => {
	const window = (timeoutMs: number) => ({ timeoutMs, nowMs: now });

	it("closes when every server has settled", () => {
		// Nothing left to wait for, whatever the window says.
		expect(isStartupComplete({ window: window(1000), startedAtMs: 0, pending: 0 })).toBe(true);
	});

	it("stays open while a server is pending and time remains", () => {
		expect(isStartupComplete({ window: window(1000), startedAtMs: clock, pending: 1 })).toBe(false);
	});

	it("closes when the window elapses", () => {
		clock = 0;
		expect(isStartupComplete({ window: window(500), startedAtMs: 0, pending: 1 })).toBe(false);
		clock = 600;
		expect(isStartupComplete({ window: window(500), startedAtMs: 0, pending: 1 })).toBe(true);
	});

	it("never closes on time at zero, only on settling", () => {
		// A server that never answers is a configuration problem to report, not
		// something to time out silently.
		clock = 0;
		expect(isStartupComplete({ window: window(0), startedAtMs: 0, pending: 1 })).toBe(false);
		clock = 1_000_000;
		expect(isStartupComplete({ window: window(0), startedAtMs: 0, pending: 1 })).toBe(false);
		expect(isStartupComplete({ window: window(0), startedAtMs: 0, pending: 0 })).toBe(true);
	});
});

describe("a server that failed is reported", () => {
	it("lists the servers that did not come up", () => {
		// A session that starts with three of four servers and says nothing about
		// the fourth leaves the user believing the tool does not exist.
		const result = reportStartup(
			[
				{ server: "alpha", ok: true },
				{ server: "beta", ok: false, reason: "spawn failed" },
				{ server: "gamma", ok: true },
			],
			{ timeoutMs: 100, nowMs: now },
			0,
		);
		expect(result.ready).toEqual(["alpha", "gamma"]);
		expect(result.failed).toEqual([{ server: "beta", reason: "spawn failed" }]);
		expect(result.settled).toBe(false);
	});

	it("is settled only when every server answered", () => {
		const all = reportStartup([{ server: "a", ok: true }], { timeoutMs: 1, nowMs: now }, 0);
		expect(all.settled).toBe(true);
		const none = reportStartup([{ server: "a", ok: false }], { timeoutMs: 1, nowMs: now }, 0);
		expect(none.settled).toBe(false);
	});

	it("gives a reason even when the caller supplies none", () => {
		const result = reportStartup([{ server: "a", ok: false }], { timeoutMs: 1, nowMs: now }, 0);
		expect(result.failed[0]!.reason).toBe("did not start");
	});
});

describe("debouncing collapses a burst to the state that matters", () => {
	const options = (debounceMs: number): DebounceOptions => ({ debounceMs, nowMs: now });

	const update = (revision: number, atMs: number) => ({
		server: "fs",
		uri: "file:///a.ts",
		receivedAtMs: atMs,
		content: `revision ${revision}`,
	});

	it("injects nothing until the burst is quiet", () => {
		clock = 0;
		const debouncer = new NotificationDebouncer(options(500));
		debouncer.record(update(1, 0));
		clock = 400;
		debouncer.record(update(2, 400));
		// Still mid-burst: the deadline restarted, because injecting on the leading
		// edge would describe a state already superseded.
		expect(debouncer.drain()).toHaveLength(0);
		clock = 1000;
		expect(debouncer.drain()).toHaveLength(1);
	});

	it("injects the newest content, not the first", () => {
		clock = 0;
		const debouncer = new NotificationDebouncer(options(100));
		for (let revision = 1; revision <= 11; revision++) {
			debouncer.record(update(revision, clock));
			clock += 10;
		}
		clock += 200;
		const drained = debouncer.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0]!.content).toBe("revision 11");
		expect(drained[0]!.collapsed).toBe(11);
	});

	it("keeps different resources apart", () => {
		// A burst on one resource says nothing about a different one.
		clock = 0;
		const debouncer = new NotificationDebouncer(options(100));
		debouncer.record({ ...update(1, 0), uri: "file:///a.ts" });
		debouncer.record({ ...update(2, 0), uri: "file:///b.ts" });
		clock = 200;
		const drained = debouncer.drain();
		expect(drained.map((entry) => entry.uri).sort()).toEqual(["file:///a.ts", "file:///b.ts"]);
	});

	it("injects everything immediately at a zero window", () => {
		clock = 0;
		const debouncer = new NotificationDebouncer(options(0));
		debouncer.record(update(1, 0));
		// No debouncing, so there is no quiet period to wait for.
		expect(debouncer.drain()).toHaveLength(1);
	});

	it("forgets everything on reset, for a settings change", () => {
		clock = 0;
		const debouncer = new NotificationDebouncer(options(500));
		debouncer.record(update(1, 0));
		expect(debouncer.size).toBe(1);
		debouncer.reset();
		expect(debouncer.size).toBe(0);
		expect(debouncer.drain()).toHaveLength(0);
	});
});

describe("injection is a setting, and off means off", () => {
	const updates = [{ server: "fs", uri: "file:///a.ts", content: "x", collapsed: 1 }];

	it("says nothing reaches the conversation when disabled", () => {
		// Not merely quiet: a disabled setting means nothing from a server reaches
		// the model at all.
		expect(injectionEnabled(false, updates)).toEqual([]);
	});

	it("describes each update when enabled", () => {
		expect(injectionEnabled(true, updates)[0]).toContain("file:///a.ts");
	});

	it("pluralises the collapsed count", () => {
		const many = [{ server: "fs", uri: "file:///a.ts", content: "x", collapsed: 3 }];
		expect(injectionEnabled(true, many)[0]).toContain("3 changes");
		expect(injectionEnabled(true, updates)[0]).toContain("1 change)");
	});
});
