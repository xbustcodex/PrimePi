import { describe, expect, it } from "vitest";
import {
	buildToolNamespacesInfo,
	CODE_MODE_KEEP_TOOLS,
	type CodeModeInput,
	resolveCodeMode,
} from "../src/code-mode.ts";

/**
 * Code mode.
 *
 * The properties that matter are both about *not lying to the model*. An
 * inactive session must keep every tool, because a partially-collapsed surface
 * that is not code mode silently removes tools. And the keep-set is a
 * correctness constraint, not a preference: `checkpoint`, `rewind` and
 * `new_context` drive machinery that keys on the direct toolResult's name, so
 * bridged they appear to succeed and do nothing.
 */

const ALL_TOOLS = ["eval", "ask", "todo", "think", "read", "edit", "bash", "checkpoint", "rewind", "new_context"];

const input = (overrides: Partial<CodeModeInput> = {}): CodeModeInput => ({
	provider: "openai-codex",
	toolMode: "code_mode_only",
	setting: "auto",
	enabledToolNames: ALL_TOOLS,
	evalTransportAvailable: true,
	...overrides,
});

describe("activation needs the bridge, not just the setting", () => {
	it("activates under auto when the catalog says the model is code-mode-only", () => {
		const resolution = resolveCodeMode(input());
		expect(resolution.active).toBe(true);
		expect(resolution.directToolNames.has("eval")).toBe(true);
	});

	it("stays off under auto for a normal model", () => {
		expect(resolveCodeMode(input({ toolMode: "default" })).active).toBe(false);
	});

	it("activates under an explicit on regardless of the catalog", () => {
		expect(resolveCodeMode(input({ setting: "on", toolMode: "default" })).active).toBe(true);
	});

	it("stays off under an explicit off even for a code-mode-only model", () => {
		expect(resolveCodeMode(input({ setting: "off" })).active).toBe(false);
	});

	it("refuses to activate without an eval transport", () => {
		// The bridge is the whole point: a keep-set the model cannot escape is worse
		// than no code mode.
		expect(resolveCodeMode(input({ evalTransportAvailable: false })).active).toBe(false);
	});

	it("refuses to activate without the eval tool", () => {
		expect(resolveCodeMode(input({ enabledToolNames: ALL_TOOLS.filter((t) => t !== "eval") })).active).toBe(false);
	});

	it("applies only to the provider that defines the mode", () => {
		expect(resolveCodeMode(input({ provider: "anthropic" })).active).toBe(false);
	});
});

describe("an inactive session keeps every tool", () => {
	it("does not partially collapse the surface", () => {
		// A keep-set without the bridge would silently remove read, edit and bash from
		// a session that never opted in.
		const resolution = resolveCodeMode(input({ setting: "off" }));
		expect(resolution.directToolNames).toEqual(new Set(ALL_TOOLS));
	});

	it("keeps tools that are not in the keep-set", () => {
		const resolution = resolveCodeMode(input({ setting: "on" }));
		expect(resolution.directToolNames.has("read")).toBe(false);
		expect(resolution.directToolNames.has("bash")).toBe(false);
	});
});

describe("the keep-set is a correctness constraint", () => {
	it("keeps checkpoint, rewind and new_context direct", () => {
		// These drive session state machinery keyed on the direct toolResult's name.
		// Bridged, the checkpoint appears to succeed and the rewind does nothing.
		const direct = resolveCodeMode(input({ setting: "on" })).directToolNames;
		for (const name of ["checkpoint", "rewind", "new_context"]) {
			expect(direct.has(name), name).toBe(true);
		}
	});

	it("declares every name the eval bridge consumes internally", () => {
		// callSessionTool consumes these before the registry, so a registered tool
		// sharing one is only reachable while it stays direct.
		for (const name of [
			"__agent__",
			"__budget__",
			"__completion__",
			"__wait__",
			"__status__",
			"__cancel__",
			"__workpool__",
		]) {
			expect(CODE_MODE_KEEP_TOOLS.has(name), name).toBe(true);
		}
	});

	it("admits an extra direct tool only when it is enabled", () => {
		const withExtra = resolveCodeMode(input({ setting: "on", extraDirectTools: ["read"] }));
		expect(withExtra.directToolNames.has("read")).toBe(true);
		// Asking for a tool this session does not have cannot expose it.
		const withMissing = resolveCodeMode(input({ setting: "on", extraDirectTools: ["nonesuch"] }));
		expect(withMissing.directToolNames.has("nonesuch")).toBe(false);
	});
});

describe("wire-name collisions have a defined winner", () => {
	const build = (tools: { name: string; customWireName?: string }[], direct: string[]) =>
		buildToolNamespacesInfo({
			tools,
			directToolNames: new Set(direct),
		});

	it("prefers a direct entry over a bridged one", () => {
		// A bridged tool keeps its own name, so a direct tool claiming that name is
		// the collision. A bridged tool is only reachable by a name the model has to
		// know to type, so losing the wire name to it is the worse outcome.
		const { info, collisions } = build(
			[{ name: "read" }, { name: "aliased", customWireName: "read" }],
			["read", "aliased"],
		);
		expect(info.functions.functions.read?.direct).toBe(true);
		expect(collisions).toHaveLength(1);
	});

	it("prefers the exact name over an alias between two direct entries", () => {
		// Matching the dispatcher's exact-name-first lookup: the entry it would route
		// to is the one the model is shown.
		const { info } = build(
			[{ name: "aliased", customWireName: "shared" }, { name: "shared" }],
			["aliased", "shared"],
		);
		expect(info.functions.functions.shared?.code_mode_name).toBe("shared");
	});

	it("keeps the first direct entry when the second is only an alias", () => {
		const { info } = build(
			[{ name: "shared" }, { name: "aliased", customWireName: "shared" }],
			["shared", "aliased"],
		);
		expect(info.functions.functions.shared?.code_mode_name).toBe("shared");
	});

	it("does not collapse two tools that merely share a name", () => {
		const { info } = build([{ name: "a" }, { name: "b" }], ["a", "b"]);
		expect(Object.keys(info.functions.functions).sort()).toEqual(["a", "b"]);
	});
});

describe("the namespace table", () => {
	it("records where a tool came from", () => {
		const { info } = buildToolNamespacesInfo({
			tools: [{ name: "mcp_thing", mcpServerName: "files" }, { name: "read" }],
			directToolNames: new Set(["read"]),
		});
		expect(info.functions.functions.mcp_thing?.source).toEqual({ kind: "mcp", server_name: "files" });
		expect(info.functions.functions.read?.source).toEqual({ kind: "harness" });
	});

	it("marks a discoverable tool as deferred", () => {
		const { info } = buildToolNamespacesInfo({
			tools: [{ name: "read", loadMode: "discoverable" }],
			directToolNames: new Set(["read"]),
		});
		expect(info.functions.functions.read?.deferred).toBe(true);
	});

	it("accepts a tool whose name collides with an inherited member", () => {
		// A null prototype keeps `toString` and `__proto__` as own entries; on a plain
		// object the tool would read or replace an inherited member and vanish.
		const { info } = buildToolNamespacesInfo({
			tools: [{ name: "toString" }, { name: "__proto__" }],
			directToolNames: new Set(["toString", "__proto__"]),
		});
		expect(Object.keys(info.functions.functions).sort()).toEqual(["__proto__", "toString"]);
		// Read it as an own property. `functions` is a null-prototype map, so a property
		// access on it resolves at the *type* level to `Function.prototype.toString` and is
		// typed as a function — the very collision this guard exists to prevent. Looking
		// the descriptor up states what the assertion means and types correctly: this is
		// the map's own entry, not something inherited.
		const own = Object.getOwnPropertyDescriptor(info.functions.functions, "toString");
		expect(own?.value?.code_mode_name).toBe("toString");
	});

	it("publishes a direct tool under its alias and a bridged one under its own name", () => {
		const { info } = buildToolNamespacesInfo({
			tools: [{ name: "read", customWireName: "r" }, { name: "edit" }],
			directToolNames: new Set(["read"]),
		});
		expect(info.functions.functions.r?.direct).toBe(true);
		expect(info.functions.functions.edit?.direct).toBe(false);
	});
});
