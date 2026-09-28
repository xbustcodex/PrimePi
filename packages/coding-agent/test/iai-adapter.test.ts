import { describe, expect, it } from "vitest";
import { IaiPersonalBackend, startIaiSession } from "../src/core/memory/iai-adapter.ts";
import { createMemoryBackend, memoryBackendDescriptors } from "../src/core/memory/registry.ts";

/**
 * The IAI adapter's behaviour when the engine is absent.
 *
 * The engine's `hippo` store imports `numpy`, a declared hard dependency that
 * is not present here, and its stdio server has no package `__main__`. Those are
 * environment facts. What matters is that neither becomes a broken agent: an
 * unreachable engine must report unavailability, must not hang, and must not leak
 * a half-open process.
 */

const MISSING_PYTHON = "definitely-not-a-python-interpreter";

describe("the IAI backend sits after every OMP backend", () => {
	it("appears in the selector without displacing the reference order", () => {
		const ids = memoryBackendDescriptors().map((entry) => entry.id);
		// The reference's five keep their positions, and the PrimePi extensions are
		// appended after them, so a user who has learned the list still selects by
		// position. `local-store` precedes `iai-personal` because it is the backend
		// whose behaviour is actually verified; see PD-9.
		expect(ids.slice(0, 5)).toEqual(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);
		expect(ids.slice(5)).toEqual(["bank-store", "local-store", "iai-personal"]);
	});

	it("leaves Off first, and Off still runs nothing", () => {
		const off = createMemoryBackend("off");
		expect(off.ok).toBe(true);
		if (!off.ok) return;
		// Off exposes no retain and no recall, so selecting it starts no memory
		// subsystem at all.
		expect(off.backend.retain).toBeUndefined();
		expect(off.backend.recall).toBeUndefined();
	});
});

describe("an unreachable engine degrades safely", () => {
	it("reports unavailability with a reason rather than an empty store", async () => {
		const backend = new IaiPersonalBackend({ python: MISSING_PYTHON, timeoutMs: 2_000 });
		const available = await backend.available();
		expect(available.ok).toBe(false);
		// A reason, not a bare false: a user selecting this needs to know whether
		// the engine is missing, misconfigured, or refusing.
		expect(available.reason?.length ?? 0).toBeGreaterThan(0);
	});

	it("recalls nothing rather than failing the caller", async () => {
		const backend = new IaiPersonalBackend({ python: MISSING_PYTHON, timeoutMs: 2_000 });
		// A missing optional memory backend must not break a session, so a recall
		// that cannot reach the engine yields no memories.
		const hits = await backend.recall({ text: "anything" });
		expect(hits).toEqual([]);
	});

	it("retains loudly, because a silently dropped memory is a lie", async () => {
		const backend = new IaiPersonalBackend({ python: MISSING_PYTHON, timeoutMs: 2_000 });
		// Unlike a recall, a write that cannot be stored must not look successful.
		await expect(
			backend.retain({ kind: "convention", text: "a fact worth keeping", provenance: { scope: "project" } }),
		).rejects.toThrow();
	});

	it("stops cleanly, leaving no process behind", async () => {
		const backend = new IaiPersonalBackend({ python: MISSING_PYTHON, timeoutMs: 1_000 });
		await backend.available();
		// Stopping an engine that never started is a no-op, not an error.
		await expect(backend.stop()).resolves.toBeUndefined();
	});
});

describe("session start reports why it failed", () => {
	it("distinguishes a missing interpreter from a refused handshake", async () => {
		const started = await startIaiSession({ python: MISSING_PYTHON, timeoutMs: 2_000 });
		expect(started.ok).toBe(false);
		if (started.ok) return;
		expect(started.reason).toMatch(/iai engine/i);
	});
});

describe("the adapter claims only what it implements", () => {
	it("reaches the engine over stdio, with no network surface", () => {
		const backend = new IaiPersonalBackend();
		expect(backend.capabilities.recall).toBe(true);
		expect(backend.capabilities.retain).toBe(true);
		// The transport is a child process over stdio, and the adapter has no URL,
		// host or port to reach: there is nothing for it to phone home to.
		expect(backend.capabilities.local).toBe(true);
	});
});
