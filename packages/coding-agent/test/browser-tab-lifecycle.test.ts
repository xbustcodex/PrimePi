import { describe, expect, it } from "vitest";
import {
	BrowserTabRegistry,
	decideDispose,
	decideTabAction,
	isOwnedBy,
	type LifecycleOptions,
	mayManage,
	type OwnedTab,
} from "../src/core/browser/tab-lifecycle.ts";

/**
 * Browser tab lifecycle.
 *
 * The property that matters most: **only a tab this session launched headlessly
 * is ours to touch.** Closing a CDP or relay browser would kill something
 * another tool or the user is using, and one session must never reap another's
 * headless tabs.
 */

const NOW = 1_000_000;
const options = (overrides: Partial<LifecycleOptions> = {}): LifecycleOptions => ({
	freezeOnTurnEnd: true,
	idleCloseSec: 1800,
	...overrides,
});

const tab = (overrides: Partial<OwnedTab> = {}): OwnedTab => ({
	id: "t1",
	launch: "headless-owned",
	sessionId: "s1",
	openedAtMs: NOW,
	lastUsedAtMs: NOW,
	persist: false,
	...overrides,
});

describe("ownership decides everything", () => {
	it("owns only a headless tab it launched", () => {
		expect(isOwnedBy("headless-owned")).toBe(true);
		expect(isOwnedBy("cdp")).toBe(false);
		expect(isOwnedBy("relay")).toBe(false);
		expect(isOwnedBy("spawned-external")).toBe(false);
	});

	it("does not manage another session's headless tab", () => {
		// Two sessions sharing a machine must not reap each other's tabs.
		expect(mayManage(tab(), "s1")).toBe(true);
		expect(mayManage(tab(), "s2")).toBe(false);
	});

	it("never manages a shared browser, whoever opened it", () => {
		for (const launch of ["cdp", "relay", "spawned-external"] as const) {
			expect(mayManage(tab({ launch }), "s1"), launch).toBe(false);
		}
	});
});

describe("freeze rather than close when a turn settles", () => {
	const context = { nowMs: NOW, sessionId: "s1", turnEnded: true, sweeping: false };

	it("freezes an owned idle tab", () => {
		// An animated page burns CPU and GPU while nothing looks at it, and
		// closing would destroy the state the agent navigated to.
		expect(decideTabAction(tab(), options(), context).action).toBe("freeze");
	});

	it("does not freeze a tab that opted out with persist", () => {
		// A tab being watched for a change the agent will come back for should keep
		// running.
		const decision = decideTabAction(tab({ persist: true }), options(), context);
		expect(decision.action).toBe("none");
		expect(decision.reason).toContain("persist");
	});

	it("does not freeze when the setting is off", () => {
		expect(decideTabAction(tab(), options({ freezeOnTurnEnd: false }), context).action).toBe("none");
	});

	it("does not freeze a tab another session owns", () => {
		const decision = decideTabAction(tab({ sessionId: "s2" }), options(), context);
		expect(decision.action).toBe("none");
		expect(decision.reason).toContain("another session");
	});

	it("does not freeze a shared browser", () => {
		const decision = decideTabAction(tab({ launch: "cdp" }), options(), context);
		expect(decision.action).toBe("none");
		expect(decision.reason).toContain("not ours");
	});

	it("does not freeze while the turn is still running", () => {
		expect(decideTabAction(tab(), options(), { ...context, turnEnded: false }).action).toBe("none");
	});
});

describe("close is a reaper, not a turn-end response", () => {
	it("closes a long-idle owned tab on a sweep", () => {
		const context = { nowMs: NOW + 2000 * 1000, sessionId: "s1", turnEnded: true, sweeping: true };
		const decision = decideTabAction(tab(), options({ idleCloseSec: 1800 }), context);
		expect(decision.action).toBe("close");
		expect(decision.reason).toContain("idle");
	});

	it("does not close on a turn end alone", () => {
		// A turn ending is not evidence the agent is finished with the tab.
		const context = { nowMs: NOW + 2000 * 1000, sessionId: "s1", turnEnded: true, sweeping: false };
		expect(decideTabAction(tab(), options({ idleCloseSec: 1800 }), context).action).toBe("freeze");
	});

	it("never closes at a zero timeout", () => {
		const context = { nowMs: NOW + 10_000_000, sessionId: "s1", turnEnded: true, sweeping: true };
		expect(decideTabAction(tab(), options({ idleCloseSec: 0 }), context).action).not.toBe("close");
	});

	it("leaves a recently used tab alone", () => {
		const context = { nowMs: NOW + 5_000, sessionId: "s1", turnEnded: true, sweeping: true };
		expect(decideTabAction(tab(), options({ idleCloseSec: 1800 }), context).action).not.toBe("close");
	});

	it("never closes a shared or foreign tab, however idle", () => {
		const context = { nowMs: NOW + 10_000_000, sessionId: "s1", turnEnded: true, sweeping: true };
		expect(decideTabAction(tab({ launch: "relay" }), options(), context).action).toBe("none");
		expect(decideTabAction(tab({ sessionId: "s2" }), options(), context).action).toBe("none");
	});
});

describe("dispose is about correctness, not tidiness", () => {
	it("reaps a tab the session owns", () => {
		// A headless tab outliving the process that launched it is a leaked browser.
		// The idle timeout is about tidiness; disposal is about correctness.
		expect(decideDispose(tab(), "s1").action).toBe("close");
	});

	it("leaves a shared browser and a foreign tab", () => {
		expect(decideDispose(tab({ launch: "cdp" }), "s1").action).toBe("none");
		expect(decideDispose(tab({ sessionId: "s2" }), "s1").action).toBe("none");
	});
});

describe("the registry", () => {
	it("records and touches a tab", () => {
		const registry = new BrowserTabRegistry("s1");
		registry.open({ id: "t1", launch: "headless-owned", nowMs: NOW });
		expect(registry.get("t1")?.lastUsedAtMs).toBe(NOW);
		registry.touch("t1", NOW + 5000);
		expect(registry.get("t1")?.lastUsedAtMs).toBe(NOW + 5000);
		// Touching an unknown tab is a no-op rather than an error, because a sweep
		// can race a close.
		expect(() => registry.touch("missing", NOW)).not.toThrow();
	});

	it("lists only what this session owns", () => {
		const registry = new BrowserTabRegistry("s1");
		registry.open({ id: "mine", launch: "headless-owned", nowMs: NOW });
		registry.open({ id: "shared", launch: "cdp", nowMs: NOW });
		expect(registry.all()).toHaveLength(2);
		expect(registry.owned().map((entry) => entry.id)).toEqual(["mine"]);
	});

	it("freezes owned tabs and leaves the rest on a turn end", () => {
		const registry = new BrowserTabRegistry("s1");
		registry.open({ id: "mine", launch: "headless-owned", nowMs: NOW });
		registry.open({ id: "persisted", launch: "headless-owned", nowMs: NOW, persist: true });
		registry.open({ id: "shared", launch: "relay", nowMs: NOW });
		const result = registry.sweep(options(), { nowMs: NOW, turnEnded: true, sweeping: false });
		expect(result.frozen).toEqual(["mine"]);
		expect(result.closed).toEqual([]);
		expect(result.skipped.map((entry) => entry.id).sort()).toEqual(["persisted", "shared"]);
	});

	it("closes a long-idle tab on a sweep and forgets it", () => {
		const registry = new BrowserTabRegistry("s1");
		registry.open({ id: "stale", launch: "headless-owned", nowMs: NOW });
		const result = registry.sweep(options({ idleCloseSec: 10 }), {
			nowMs: NOW + 20_000,
			turnEnded: true,
			sweeping: true,
		});
		expect(result.closed).toEqual(["stale"]);
		expect(registry.get("stale")).toBeUndefined();
	});

	it("reaps everything it owns at dispose", () => {
		const registry = new BrowserTabRegistry("s1");
		registry.open({ id: "a", launch: "headless-owned", nowMs: NOW });
		registry.open({ id: "b", launch: "cdp", nowMs: NOW });
		expect(registry.dispose()).toEqual(["a"]);
		expect(registry.all()).toHaveLength(1);
	});
});
