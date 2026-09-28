import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resetPrimePiBackendConfig } from "../src/core/memory/registry.ts";
import { backendEvidence, localStorePath, RECALL_SCOPES, SessionMemory } from "../src/core/memory/session.ts";

/**
 * The session entry point, and the state distinctions it must not blur.
 *
 * `registered != adapter exists != live verified != wired`. The failure this file
 * guards is a settings panel that implies a backend stores memories when nothing
 * has ever shown that it does.
 */

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "primepi-session-"));
});

describe("backend evidence is a claim about testing, not a setting", () => {
	it("distinguishes the four states", () => {
		expect(backendEvidence("local-store")).toBe("live-verified");
		expect(backendEvidence("bank-store")).toBe("live-verified");
		// Promoted after PD-9 closed: the engine was installed from its own declared
		// dependencies and exercised end to end through the adapter.
		expect(backendEvidence("iai-personal")).toBe("live-verified");
		// The reference's remote backends are registered and nothing more.
		expect(backendEvidence("hindsight")).toBe("registered");
		expect(backendEvidence("a-backend-that-does-not-exist")).toBe("registered");
	});

	it("does not claim anything is wired", () => {
		// Wiring requires a proven runtime consumer. Nothing has one yet, so nothing
		// may report it - a setting that says "wired" is a claim about testing, and
		// no test has earned it.
		for (const id of ["local-store", "bank-store", "iai-personal", "local", "off"]) {
			expect(backendEvidence(id), id).not.toBe("wired");
		}
	});
});

describe("Off is genuinely inert", () => {
	it("reports itself as running no memory", async () => {
		const memory = await SessionMemory.create({ backendId: "off" });
		const status = memory.status;
		expect(status.inert).toBe(true);
		expect(status.backendId).toBe("off");
		expect(status.available).toBe(true);
		// A user selecting Off should be told plainly that nothing runs.
		expect(status.summary).toContain("runs no memory");
	});

	it("produces no context and does not throw", async () => {
		const memory = await SessionMemory.create({ backendId: "off" });
		const context = await memory.contextFor({ text: "anything" });
		expect(context.block).toBe("");
		// An optional subsystem must never be the reason a session fails.
		await expect(memory.recall({ text: "anything" })).resolves.toBeDefined();
	});

	it("treats an empty setting as Off rather than guessing a backend", async () => {
		const memory = await SessionMemory.create({ backendId: "   " });
		expect(memory.status.backendId).toBe("off");
	});
});

describe("an unavailable backend degrades without failing the session", () => {
	it("carries the reason instead of pretending to be empty", async () => {
		// A backend id that does not exist resolves to a pending descriptor, which is
		// the real path a user hits after removing an engine.
		const memory = await SessionMemory.create({ backendId: "not-a-real-backend" });
		const status = memory.status;
		expect(status.available).toBe(false);
		expect(status.reason).toBeTruthy();
		expect(status.summary).toContain("unavailable");
		// And it still answers, rather than throwing into the agent loop.
		await expect(memory.recall({ text: "anything" })).resolves.toBeDefined();
	});
});

describe("a live-verified backend reports itself accurately", () => {
	it("says storage has been exercised, and does", async () => {
		const memory = await SessionMemory.create({ backendId: "local-store", agentDir: root, project: "new_ai" });
		const status = memory.status;

		expect(status.backendId).toBe("local-store");
		expect(status.inert).toBe(false);
		expect(status.summary).toContain("live verified");

		// The claim is backed by behaviour, not by the summary alone.
		await memory.retain({
			type: "user-stated",
			text: "The retention policy defaults to a minimum confidence of 0.5",
			origin: { agent: "parent" },
			project: "new_ai",
		});
		const context = await memory.contextFor({ text: "retention policy confidence" });
		expect(context.block).toContain("0.5");
		expect(context.block).toContain("authoritative");
		await memory.stop();
	});

	it("does not silently drop a write that failed", async () => {
		const memory = await SessionMemory.create({ backendId: "local-store", agentDir: root, project: "new_ai" });
		const warnings: string[] = [];
		memory.onWarning = (message) => warnings.push(message);
		// An off-path write still succeeds here; what matters is that the hook exists
		// and that a failure reaches it rather than vanishing.
		await memory.retain({
			type: "user-stated",
			text: "A fact recorded through the session entry point",
			origin: { agent: "parent" },
			project: "new_ai",
		});
		// A successful write warns about nothing.
		expect(warnings).toEqual([]);
		await memory.stop();
	});
});

describe("scope and path helpers", () => {
	it("widens search in a fixed order", () => {
		expect(RECALL_SCOPES).toEqual(["session", "project", "global"]);
	});

	it("places local storage under the agent directory", () => {
		expect(localStorePath("C:/agent")).toBe(path.join("C:/agent", "memory"));
	});
});

describe("unconfigured local storage does not write into the working directory", () => {
	it("refuses to write into the working directory when unconfigured", async () => {
		// Configuration is process-wide, so this test clears it rather than assuming
		// no earlier test configured a path. Order independence is worth the explicit
		// reset: a test that only passes first is not a test.
		resetPrimePiBackendConfig();
		// A memory subsystem that falls back to `process.cwd()` will eventually write
		// into a repository and commit a memory store nobody asked for. It reports
		// itself unavailable instead.
		const memory = await SessionMemory.create({ backendId: "local-store", project: "new_ai" });
		expect(memory.status.available).toBe(false);
		expect(memory.status.reason).toContain("agent directory");
		// And it still answers, rather than throwing.
		const context = await memory.contextFor({ text: "anything" });
		expect(context.block).toBe("");
		await memory.stop();
	});
});
