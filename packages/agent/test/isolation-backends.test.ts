import { describe, expect, it } from "vitest";
import {
	backendsOfClass,
	candidateOrder,
	classOf,
	ISOLATION_BACKEND_ORDER,
	type IsolationBackend,
	isIsolationBackend,
	labelFor,
	resolveIsolationBackend,
} from "../src/isolation-backends.ts";

/**
 * Isolation backends.
 *
 * The property that matters is **falling back is reported, never silent**. A
 * caller that assumed a reflink and received a full copy has a materially
 * different latency profile, and `fellBack` is the only thing that tells it so.
 * The second property is that an explicit preference is not reordered: the
 * chosen backend leads, and its whole class is exhausted before another class
 * is entered.
 */

const REFLOWS: IsolationBackend[] = ["apfs", "btrfs", "zfs", "reflink"];
const ALL = [...ISOLATION_BACKEND_ORDER];

const never = () => undefined;
const alwaysFails = (reason: string) => () => reason;

describe("backends are grouped by behaviour, not by name", () => {
	it("puts the copy-on-write mechanisms in one class", () => {
		// A true clone is instant and fully independent from the moment it exists.
		for (const backend of ["apfs", "btrfs", "zfs", "reflink"] as const) {
			expect(classOf(backend), backend).toBe("reflink");
		}
	});

	it("separates the stacked-view mechanisms", () => {
		for (const backend of ["overlayfs", "projfs"] as const) {
			expect(classOf(backend), backend).toBe("overlay");
		}
	});

	it("puts the plain copies last", () => {
		// Correct everywhere and slow everywhere, so it is the guaranteed answer
		// rather than a good one.
		for (const backend of ["block-clone", "rcopy"] as const) {
			expect(classOf(backend), backend).toBe("copy");
		}
	});

	it("orders copies last in the global list", () => {
		const order = ISOLATION_BACKEND_ORDER;
		expect(order.indexOf("rcopy")).toBe(order.length - 1);
		expect(Math.max(...order.map((b) => (order.indexOf(b) < 4 ? 0 : 1)))).toBe(1);
	});

	it("lists each class in preference order", () => {
		expect(backendsOfClass("reflink")).toEqual(REFLOWS);
	});

	it("recognises every catalogued backend and nothing else", () => {
		for (const backend of ALL) expect(isIsolationBackend(backend)).toBe(true);
		expect(isIsolationBackend("nonesuch")).toBe(false);
		expect(isIsolationBackend(undefined)).toBe(false);
	});

	it("labels each backend distinctly enough to display", () => {
		const labels = ALL.map(labelFor);
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe("an explicit preference is not reordered", () => {
	it("leads with the chosen backend", () => {
		expect(candidateOrder("btrfs", ALL)[0]).toBe("btrfs");
	});

	it("exhausts its class before entering another", () => {
		// On a btrfs volume, btrfs beats APFS even though APFS is listed first: both
		// are reflinks and the native one is faster.
		const order = candidateOrder("btrfs", ALL);
		const reflinks = order.filter((b) => classOf(b) === "reflink");
		expect(reflinks).toEqual(["btrfs", "apfs", "zfs", "reflink"]);
		// No copy-class backend appears before every reflink has.
		expect(order.indexOf("rcopy")).toBeGreaterThan(order.indexOf("reflink"));
	});

	it("still cross-classes when the class is exhausted", () => {
		const order = candidateOrder("projfs", ALL);
		expect(order[0]).toBe("projfs");
		expect(order).toContain("overlayfs");
		expect(order).toContain("rcopy");
	});

	it("orders auto by the global list instead", () => {
		expect(candidateOrder("auto", ALL)).toEqual(ALL);
	});

	it("drops backends that are not available", () => {
		expect(candidateOrder("btrfs", ["btrfs", "rcopy"])).toEqual(["btrfs", "rcopy"]);
	});
});

describe("falling back is reported, never silent", () => {
	it("does not report a fallback when the choice is honoured", () => {
		const handle = resolveIsolationBackend({ preferred: "btrfs", available: ALL, probe: never, mergedDir: "/m" });
		expect(handle).toMatchObject({ backend: "btrfs", fellBack: false, fallbackReason: null });
	});

	it("reports a fallback and names the reason", () => {
		// A caller that assumed a reflink and got a full copy has a different latency
		// profile and has to be able to say so.
		const handle = resolveIsolationBackend({
			preferred: "apfs",
			available: ALL,
			probe: (backend) => (backend === "apfs" ? "clonefile is not supported on this volume" : undefined),
			mergedDir: "/m",
		});
		expect(handle.fellBack).toBe(true);
		expect(handle.fallbackReason).toContain("apfs");
		expect(handle.fallbackReason).toContain("clonefile");
		expect(handle.backend).not.toBe("apfs");
	});

	it("does not report a fallback under auto", () => {
		// Auto never had a preference to deviate from.
		const handle = resolveIsolationBackend({ preferred: "auto", available: ALL, probe: never, mergedDir: "/m" });
		expect(handle.fellBack).toBe(false);
	});

	it("prefers a same-class backend over a cross-class one when falling back", () => {
		// btrfs unavailable should land on another reflink, not on a full copy.
		const handle = resolveIsolationBackend({
			preferred: "btrfs",
			available: ALL,
			probe: (backend) => (backend === "btrfs" ? "not a btrfs volume" : undefined),
			mergedDir: "/m",
		});
		expect(handle.backend).toBe("apfs");
		expect(classOf(handle.backend)).toBe("reflink");
	});

	it("hands back the merged directory it was given", () => {
		expect(
			resolveIsolationBackend({ preferred: "auto", available: ALL, probe: never, mergedDir: "/m" }).mergedDir,
		).toBe("/m");
	});
});

describe("no backend at all is an error, not an empty result", () => {
	it("throws when nothing is available", () => {
		expect(() =>
			resolveIsolationBackend({ preferred: "auto", available: [], probe: never, mergedDir: "/m" }),
		).toThrow(/No isolation backend is available/);
	});

	it("throws when every probe fails, naming each candidate", () => {
		// The probe mechanism is named rather than the failure text: it is what tells a
		// reader which capability was missing.
		expect(() =>
			resolveIsolationBackend({
				preferred: "auto",
				available: ["apfs", "rcopy"],
				probe: alwaysFails("denied"),
				mergedDir: "/m",
			}),
		).toThrow(/apfs \(clonefile\), rcopy \(copy\)/);
	});

	it("does not silently produce a copy when rcopy was excluded", () => {
		// rcopy has no prerequisites, so it is the guaranteed answer; excluding it is
		// a deliberate choice and must be respected rather than overridden.
		expect(() =>
			resolveIsolationBackend({ preferred: "auto", available: ["apfs"], probe: alwaysFails("no"), mergedDir: "/m" }),
		).toThrow();
	});
});
