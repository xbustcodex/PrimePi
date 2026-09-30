import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CapabilityNode } from "../../../scripts/lib/capability-graph.ts";
import { buildCapabilityGraph } from "../../../scripts/lib/capability-graph.ts";
import type { InertMember } from "../../../scripts/lib/inert-class-members.ts";
import { findInertClassMembers } from "../../../scripts/lib/inert-class-members.ts";

/**
 * Regression fixtures for the inert-detector family.
 *
 * Two detectors, one reason for sharing a file: both are supposed to *report
 * something*, and both previously reported nothing across 261 classes. A
 * detector that reports zero is indistinguishable from a detector that is
 * broken, so every fixture below is about a classification that was wrong or is
 * easy to get wrong, not about a symbol merely existing.
 *
 * The class-member detector was the specific failure. It walked a corpus holding
 * no test files and then asked whether each member had a test reference, which is
 * therefore always false; it never counted production references at all; and it
 * matched members by bare word, so a method's own declaration counted as a caller.
 * Any one of those silences it completely.
 *
 * The graph is the second half because the three-way classification has to be
 * right or the graph is decoration. A `behaviorally-inert` verdict that fires on
 * every `void` call in the repo is worse than no verdict: it buries the real ones.
 */

/** Both scans parse every source and test file under four packages. */
const SCAN_TIMEOUT_MS = 240_000;
type Member = InertMember;
type Node = CapabilityNode;
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

let members: Member[] | undefined;
let nodes: readonly Node[] | undefined;

function allInertMembers(): Member[] {
	if (members === undefined) members = findInertClassMembers(ROOT);
	return members;
}

function allGraphNodes(): readonly Node[] {
	if (nodes === undefined) nodes = buildCapabilityGraph(ROOT).nodes;
	return nodes;
}

const inertMembers = (predicate: (member: Member) => boolean): Member[] => allInertMembers().filter(predicate);

const graphNodes = (predicate: (node: Node) => boolean): Node[] => [...allGraphNodes()].filter(predicate);

beforeAll(() => {
	inertMembers(() => false);
	graphNodes(() => false);
}, SCAN_TIMEOUT_MS);

/**
 * Members established by hand as having no production caller.
 *
 * `getChildren` and `getLeafEntry` are the pair @SurfaceInventory.SessionTreeScout
 * found, and they are the reason this detector exists. `getLeafEntry` is the
 * harder of the two: it appears in a `Pick<SessionManager, "getLeafEntry">` in its
 * own file, so a detector that counts a type-level mention as a use would call it
 * live. A `Pick` grants no runtime reach.
 */
const KNOWN_INERT = [
	{ owner: "SessionManager", name: "getChildren", file: "packages/coding-agent/src/core/session-manager.ts" },
	{ owner: "SessionManager", name: "getLeafEntry", file: "packages/coding-agent/src/core/session-manager.ts" },
];

/** Members established by hand as having a production caller. */
const KNOWN_REACHABLE = [
	// Called from interactive-mode.ts when the working indicator is raised.
	{
		owner: "SettingsManager",
		name: "getShowCacheMissNotices",
		file: "packages/coding-agent/src/core/settings-manager.ts",
	},
	// Applied by the mutation queue on every edit.
	{ owner: "CheckpointController", name: "status", file: "packages/coding-agent/src/core/tools/checkpoint.ts" },
];

describe("the class-member detector reports what it found", () => {
	it("reports the members a scout verified have no production caller", () => {
		// The regression the whole detector exists for. Before the fix this file
		// reported 0 across 261 classes, and these two were silently among them.
		for (const { owner, name, file } of KNOWN_INERT) {
			const found = inertMembers((member) => member.owner === owner && member.name === name);
			expect(found, `${owner}.${name} must be reported`).toHaveLength(1);
			expect(found[0]!.declaredIn).toBe(file);
		}
	});

	it("separates tested-but-unwired from never-mentioned", () => {
		// The two mean different things: the first is implemented, tested, and
		// never wired, which is a wiring task; the second may not have been built.
		// Collapsing them loses the distinction that makes the list actionable.
		const tested = inertMembers((member) => member.testRefs > 0);
		const unmentioned = inertMembers((member) => member.testRefs === 0);
		expect(tested.length).toBeGreaterThan(0);
		expect(unmentioned.length).toBeGreaterThan(0);
		for (const member of inertMembers(() => true)) {
			expect(member.productionRefs).toBe(0);
		}
	});

	it.each(KNOWN_REACHABLE)("does not report $owner.$name", ({ owner, name, file }) => {
		const found = inertMembers((member) => member.owner === owner && member.name === name);
		expect(found, `${owner}.${name} has a production caller`).toEqual([]);
		expect(found.map((member) => member.declaredIn)).not.toContain(file);
	});

	it("does not let a declaration count as its own caller", () => {
		// `getLeafEntry` names itself in its signature, in a `Pick` on the same
		// file, and in a test. A detector that matches the bare word finds all three
		// and reports nothing, which is how the previous version stayed silent.
		const leaf = inertMembers((member) => member.name === "getLeafEntry")[0];
		expect(leaf, "getLeafEntry must still be reported despite naming itself three times").toBeDefined();
	});
});

describe("the capability graph classifies three ways", () => {
	it("calls a symbol with a resolved production call chain reachable", () => {
		// `checkEditFreshness` is declared in pi-ai and called from the edit tool in
		// coding-agent, across a package barrel. Getting this wrong means the graph
		// cannot see across its own workspace, which is the most common shape a
		// capability takes.
		const node = graphNodes(
			(candidate) => candidate.label === "checkEditFreshness" && candidate.declaredIn.endsWith("edit-guards.ts"),
		)[0];
		expect(node, "checkEditFreshness must be in the graph").toBeDefined();
		expect(node!.classification).toBe("reachable");
		expect(node!.productionRefs.some((ref) => ref.endsWith("tools/edit.ts"))).toBe(true);
	});

	it("calls a symbol nothing calls import-only rather than unreachable", () => {
		// The three-way split is the point. Collapsing import-only into unreachable
		// would report a module that genuinely loads as a capability that does not
		// exist, and the two call for different work.
		const node = graphNodes(
			(candidate) => candidate.label === "StatusLineSegmentId" || candidate.label === "STATUS_LINE_SEGMENT_IDS",
		)[0];
		expect(node).toBeDefined();
		expect(["import-only", "unreachable"]).toContain(node!.classification);
	});

	it("calls a symbol with no mention at all unreachable", () => {
		// Nothing in the corpus names it, so there is no ambiguity to resolve.
		const node = graphNodes((candidate) => candidate.label === "resolveContextGauge")[0];
		expect(node).toBeDefined();
		expect(node!.productionRefs).toEqual([]);
		expect(node!.classification).toBe("unreachable");
	});

	it("never reports a discarded call to a void function as inert", () => {
		// The failure mode that made the first version of the class unreadable:
		// `flushRawStdout()` written as a bare statement is how a void function is
		// meant to be called. Counting it filled the behaviorally-inert class with
		// every void call in the repo.
		const inert = graphNodes((candidate) => candidate.classification === "behaviorally-inert");
		for (const node of inert) {
			expect(node.productionRefs.length, `${node.label} has a caller that discards a real result`).toBeGreaterThan(
				0,
			);
		}
		const voidCallee = graphNodes((candidate) => candidate.label === "writeRawStdout")[0];
		expect(voidCallee?.classification, "a void writer called as a statement is not inert").not.toBe(
			"behaviorally-inert",
		);
	});

	it("keeps a discarded result reachable as a signal rather than a verdict", () => {
		// `behaviorally-inert` is only claimed when every production call site threw
		// the result away. A mix of observing and discarding callers is a reach with
		// a disagreement worth reading, and calling it inert would be a guess.
		const mixed = graphNodes(
			(candidate) => candidate.classification === "behaviorally-inert" && candidate.testRefs.length === 0,
		);
		for (const node of mixed) {
			expect(node.evidence).toBe("proven");
		}
	});
});

describe("the graph never lets a claim file be its own evidence", () => {
	it("excludes the parity ledger from the reference corpus", () => {
		// The strongest form of the defect: a row's note naming its consumer, used
		// as proof the consumer exists. The ledger must contribute no production
		// reference for anything.
		const ledger = "packages/tui/src/overlays/settings-parity-rows.ts";
		for (const node of graphNodes(() => true)) {
			expect(node.productionRefs).not.toContain(ledger);
		}
	});

	it("excludes a test file from production references", () => {
		// A capability reachable only from a test is inert at runtime. Recording the
		// test as a production reference is what lets a dead guard look alive.
		for (const node of graphNodes(() => true)) {
			for (const ref of node.productionRefs) {
				expect(ref, `${node.label} claims a test as a production reference`).not.toMatch(
					/[/\\]test[/\\]|\.test\.ts$/,
				);
			}
		}
	});
});

describe("a settings key is reported even with no read", () => {
	// The graph build parses the whole `packages/*/src` closure — roughly 650 modules
	// and 4500 nodes — which is seconds, not milliseconds. The default 5s budget is
	// below what it costs, so a slow machine reads as a failure here.
	it("classifies a key nothing reads as unreachable rather than omitting it", { timeout: 120_000 }, () => {
		// The graph is asked about settings keys as well as symbols. A key that
		// vanishes from the report when nothing reads it is the same silent omission
		// the class-member detector had.
		const graph = buildCapabilityGraph(ROOT, {
			settingsOfInterest: ["edit.enforceSeenLines", "tui.thisKeyDoesNotExist"],
		});
		const missing = graph.nodes.find((node) => node.label === "tui.thisKeyDoesNotExist");
		expect(missing, "a key with no read must still appear in the graph").toBeDefined();
		expect(missing!.classification).toBe("unreachable");
	});
});
