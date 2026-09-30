import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IaiPersonalBackend } from "../src/core/memory/iai-adapter.ts";

/**
 * The PrimePi adapter driving the real IAI engine.
 *
 * This is the PD-9 close-out, run from the test suite rather than a script, so
 * it cannot rot. It spawns the actual `iai_mcp.core` process, speaks the real
 * protocol to it, and asserts on what the engine actually returns.
 *
 * Skipped, loudly, when the engine is not present. A skip is not a pass: the
 * reason is printed so a green run cannot be mistaken for verification that did
 * not happen.
 *
 * Storage is isolated through the engine's own `IAI_MCP_STORE` override, which
 * also relocates the crypto key. The owner's personal memories are never read,
 * written, or decrypted.
 */

const PYTHON = "C:/Users/xkali/new_ai/iai-personal-memory-engine/.venv/Scripts/python.exe";
const IAI = "C:/Users/xkali/new_ai/iai-personal-memory-engine";

/** A unique marker per run, so a stale store can never satisfy a lookup. */
const MARKER = `primepi-pd9-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(16)}`;

async function engineAvailable(): Promise<boolean> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		await promisify(execFile)(PYTHON, ["-c", "import iai_mcp, numpy, cryptography"], { cwd: IAI, timeout: 120_000 });
		return true;
	} catch {
		return false;
	}
}

/** The engine refuses to open a store with no key; this is its documented bootstrap. */
async function bootstrapStore(store: string): Promise<void> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	await promisify(execFile)(PYTHON, ["-m", "iai_mcp.cli", "crypto", "init"], {
		env: { ...process.env, IAI_MCP_STORE: store },
		timeout: 300_000,
	});
}

const available = await engineAvailable();
if (!available) {
	console.warn(
		"[pd9] SKIPPED: the IAI engine is not runnable here (expected python at " +
			`${PYTHON}). These tests are the PD-9 close-out and are NOT passing - they did not run.`,
	);
}

describe.skipIf(!available)("the PrimePi adapter against the live IAI engine", () => {
	it("captures, recalls, and survives a restart", async () => {
		const store = await mkdtemp(path.join(tmpdir(), "primepi-pd9-"));
		await bootstrapStore(store);

		const backend = new IaiPersonalBackend({
			python: PYTHON,
			cwd: IAI,
			dataDir: store,
			timeoutMs: 120_000,
		});

		// 1. The adapter connects to a real engine process.
		const readiness = await backend.available();
		expect(readiness.ok, readiness.reason).toBe(true);

		// 2. Retention goes through the adapter, not around it.
		const record = await backend.retain({
			kind: "decision",
			text: `${MARKER} marks a PrimePi adapter verification record about the failover budget`,
			provenance: { scope: "project", project: "primepi-pd9" },
		});
		expect(record).toBeDefined();

		// 3. The memory comes back through the adapter's recall.
		const hits = await backend.recall({ text: MARKER, limit: 5 });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((hit) => hit.record.text.includes(MARKER))).toBe(true);
		// The engine's own relevance score survives the mapping, rather than being
		// flattened to a constant that would throw its ranking away.
		expect(hits.some((hit) => hit.score > 0)).toBe(true);

		// 4. Shutdown, then a fresh process against the same store.
		await backend.stop();

		const restarted = new IaiPersonalBackend({
			python: PYTHON,
			cwd: IAI,
			dataDir: store,
			timeoutMs: 120_000,
		});
		expect((await restarted.available()).ok).toBe(true);
		const afterRestart = await restarted.recall({ text: MARKER, limit: 5 });
		// This is the assertion that matters: the memory was durable, not cached in
		// a process that happened to still be alive.
		expect(afterRestart.some((hit) => hit.record.text.includes(MARKER))).toBe(true);

		await restarted.stop();
	}, 300_000);

	it("rejects a non-UUID record id with an explanation", async () => {
		const store = await mkdtemp(path.join(tmpdir(), "primepi-pd9b-"));
		await bootstrapStore(store);
		const backend = new IaiPersonalBackend({ python: PYTHON, cwd: IAI, dataDir: store, timeoutMs: 120_000 });

		// The engine's `UUID(params["id"])` would raise and the whole request would
		// fail with an opaque message. Saying why is the point of checking here.
		await expect(backend.contradict({ recordId: "not-a-uuid", text: "replacement" })).rejects.toThrow(/not a UUID/);
		await backend.stop();
	}, 300_000);

	it("reports the engine's measured encryption, with the cache caveat", () => {
		const backend = new IaiPersonalBackend();
		// True for the record store, which was measured. The one plaintext derived
		// cache is why the capability comment and PD-9 exist rather than a bare flag.
		expect(backend.capabilities.encryptedAtRest).toBe(true);
	});
});
