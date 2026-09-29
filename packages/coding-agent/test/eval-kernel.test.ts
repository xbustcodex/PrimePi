import { describe, expect, it } from "vitest";
import {
	decideKernel,
	describeKernelMode,
	isSameKernel,
	type KernelIdentity,
	kernelKey,
	pythonAvailable,
	resolveInterpreter,
} from "../src/core/eval/kernel.ts";

/**
 * The Python kernel.
 *
 * The property that matters most: **a retained kernel is only reused when the
 * whole identity matches.** Keyed on session alone, a user who changes the
 * interpreter mid-session silently keeps talking to the old one, and a
 * version-dependent result gets attributed to the new one.
 */

const base: KernelIdentity = { cwd: "/repo", sessionId: "s1", interpreter: "/usr/bin/python3.12" };

describe("kernel identity", () => {
	it("is stable for the same identity", () => {
		expect(kernelKey(base)).toBe(kernelKey({ ...base }));
	});

	it("differs when the working directory differs", () => {
		// A kernel retained across a directory change sees a different filesystem.
		expect(isSameKernel(base, { ...base, cwd: "/other" })).toBe(false);
	});

	it("differs when the session differs", () => {
		expect(isSameKernel(base, { ...base, sessionId: "s2" })).toBe(false);
	});

	it("differs when the interpreter differs", () => {
		// The failure this prevents: a user changes python.interpreter and keeps
		// talking to the old one, with results attributed to the new.
		expect(isSameKernel(base, { ...base, interpreter: "/usr/bin/python3.13" })).toBe(false);
	});

	it("distinguishes an absent interpreter from an empty one consistently", () => {
		expect(kernelKey({ cwd: "/r", sessionId: "s" })).toBe(kernelKey({ cwd: "/r", sessionId: "s", interpreter: "" }));
	});
});

describe("session mode", () => {
	it("reuses a matching kernel", () => {
		const key = kernelKey(base);
		const decision = decideKernel({ mode: "session", identity: base, runningKey: key });
		expect(decision.action).toBe("reuse");
	});

	it("starts when nothing is running", () => {
		expect(decideKernel({ mode: "session", identity: base }).action).toBe("start");
	});

	it("replaces a kernel whose identity does not match", () => {
		// A kernel the caller did not ask for is worse than a slow one: it is
		// running an interpreter or a directory they have moved away from.
		const decision = decideKernel({
			mode: "session",
			identity: base,
			runningKey: kernelKey({ ...base, cwd: "/old" }),
		});
		expect(decision.action).toBe("start");
		expect(decision.reason).toContain("different identity");
	});
});

describe("per-call mode is isolation, not slowness", () => {
	it("always starts fresh, even with a matching kernel running", () => {
		const decision = decideKernel({ mode: "per-call", identity: base, runningKey: kernelKey(base) });
		expect(decision.action).toBe("start-fresh");
	});

	it("says what the mode buys", () => {
		// No leftover variable, no monkey-patched import, no class mutated by an
		// earlier run.
		expect(decideKernel({ mode: "per-call", identity: base }).reason).toContain("cannot interfere");
		expect(describeKernelMode("per-call")).toContain("can affect this one");
	});

	it("describes the session mode as persistence", () => {
		expect(describeKernelMode("session")).toContain("survives between calls");
	});
});

describe("which interpreter runs", () => {
	it("uses a configured interpreter exactly, and skips discovery", () => {
		// A user who names an exact executable has said which one, and a search that
		// quietly substituted another makes every version-dependent result
		// unattributable.
		const resolution = resolveInterpreter({ configured: "/usr/bin/python3.12", discoverySucceeded: false });
		expect(resolution.source).toBe("configured");
		if (resolution.source !== "configured") throw new Error("expected a configured interpreter");
		expect(resolution.interpreter).toBe("/usr/bin/python3.12");
		expect(resolution.reason).toContain("skipped");
	});

	it("prefers the configured interpreter over a discovered one", () => {
		const resolution = resolveInterpreter({ configured: "/opt/py", discoverySucceeded: true });
		if (resolution.source !== "configured") throw new Error("the configured interpreter must win");
		expect(resolution.interpreter).toBe("/opt/py");
	});

	it("treats a blank configured value as absent", () => {
		expect(resolveInterpreter({ configured: "   ", discoverySucceeded: true }).source).toBe("discover");
	});

	it("falls back to discovery when none is configured", () => {
		expect(resolveInterpreter({ discoverySucceeded: true }).source).toBe("discover");
	});

	it("reports unavailable rather than guessing", () => {
		const resolution = resolveInterpreter({ discoverySucceeded: false });
		expect(resolution.source).toBe("unavailable");
		expect(pythonAvailable(resolution)).toBe(false);
	});

	it("is available when either route resolves", () => {
		expect(pythonAvailable(resolveInterpreter({ configured: "/opt/py", discoverySucceeded: false }))).toBe(true);
		expect(pythonAvailable(resolveInterpreter({ discoverySucceeded: true }))).toBe(true);
	});
});
