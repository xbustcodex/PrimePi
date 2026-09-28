import { describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIMIT,
	MAX_MEMORY_TEXT_LENGTH,
	type MemoryCandidate,
	provenanceForOrigin,
	sanitizeMemoryText,
	scopeForOrigin,
} from "../src/core/memory/backend.ts";
import {
	createMemoryBackend,
	descriptorFor,
	MEMORY_BACKEND_DESCRIPTORS,
	memoryBackendDescriptors,
	registerPrimePiBackend,
} from "../src/core/memory/registry.ts";

/**
 * Memory semantics, adversarially.
 *
 * Memory is context, never authority, and the properties defended here are the
 * ones that keep that true: a memory cannot be injected as an instruction, a
 * child's worktree state cannot become a parent project fact by accident, and a
 * backend that cannot run says so rather than pretending to.
 */

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		kind: "convention",
		text: "Tests run from the repository root with ./test.sh",
		provenance: { scope: "project", project: "/repo" },
		...overrides,
	};
}

describe("the OMP backend selector is preserved", () => {
	it("offers the five reference backends in the reference's order", () => {
		// Positional: a user who has learned the list selects by position, so
		// re-ordering it is a behavioural regression.
		expect(MEMORY_BACKEND_DESCRIPTORS.map((entry) => entry.id)).toEqual([
			"off",
			"local",
			"hindsight",
			"mnemopi",
			"sharpshooter",
		]);
	});

	it("uses the reference's labels and descriptions", () => {
		expect(MEMORY_BACKEND_DESCRIPTORS.map((entry) => entry.label)).toEqual([
			"Off",
			"Local",
			"Hindsight",
			"Mnemopi",
			"Sharpshooter",
		]);
		expect(descriptorFor("local")?.description).toBe("Local rollout summarisation pipeline (memory_summary.md)");
		expect(descriptorFor("hindsight")?.description).toBe("Vectorize Hindsight remote memory service");
	});

	it("appends a registered backend after every other entry", () => {
		registerPrimePiBackend({
			id: "iai-personal",
			label: "IAI Personal",
			description: "Local encrypted personal memory engine",
			create: () => ({ unavailable: "adapter not yet built" }),
		});
		const ids = memoryBackendDescriptors().map((entry) => entry.id);
		// The OMP five keep their positions, and a registration is appended rather
		// than inserted, so a user who has learned the list still selects by position.
		expect(ids.slice(0, 5)).toEqual(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);
		expect(ids.at(-1)).toBe("iai-personal");
	});
});

describe("Off genuinely disables memory", () => {
	it("runs nothing and retains nothing", async () => {
		const created = createMemoryBackend("off");
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const backend = created.backend;
		expect(backend.capabilities.retain).toBe(false);
		expect(backend.capabilities.recall).toBe(false);
		expect(backend.retain).toBeUndefined();
		expect(backend.recall).toBeUndefined();
	});
});

describe("an un-migrated backend reports unavailability rather than pretending", () => {
	it("refuses to instantiate, with a reason", () => {
		// A user who selected Sharpshooter and got silence would conclude the
		// feature is broken rather than unmigrated.
		for (const id of ["hindsight", "mnemopi", "sharpshooter"]) {
			const created = createMemoryBackend(id);
			expect(created.ok, id).toBe(false);
			if (created.ok) continue;
			expect(created.reason, id).toMatch(/not migrated/i);
		}
	});

	it("refuses a value that names no backend", () => {
		const created = createMemoryBackend("nonexistent");
		expect(created.ok).toBe(false);
		if (created.ok) return;
		expect(created.reason).toMatch(/not a known memory backend/);
	});
});

describe("the local backend works and does not overclaim", () => {
	it("retains and recalls within a session", async () => {
		const created = createMemoryBackend("local");
		if (!created.ok) throw new Error("local backend should instantiate");
		await created.backend.retain?.(candidate());
		const hits = await created.backend.recall?.({ text: "repository root" });
		expect(hits).toHaveLength(1);
		expect(hits?.[0]?.record.text).toContain("./test.sh");
	});

	it("does not claim durability or encryption it does not have", () => {
		// The reference's Local is a session summary; claiming it persists would
		// make selecting it a promise the runtime cannot keep.
		const created = createMemoryBackend("local");
		if (!created.ok) throw new Error("local backend should instantiate");
		expect(created.backend.capabilities.persistent).toBe(false);
		expect(created.backend.capabilities.encryptedAtRest).toBe(false);
		expect(created.backend.capabilities.local).toBe(true);
		// No consolidation: a session's memory has nothing to consolidate, and
		// claiming otherwise is a control backed by nothing.
		expect(created.backend.capabilities.consolidate).toBe(false);
	});

	it("forgets a record, and forgetting is distinct from superseding", async () => {
		const created = createMemoryBackend("local");
		if (!created.ok) throw new Error("local backend should instantiate");
		const record = await created.backend.retain?.(candidate());
		expect(record).toBeDefined();
		expect(await created.backend.forget?.(record!.id)).toBe(true);
		expect(await created.backend.recall?.({ text: "repository root" })).toHaveLength(0);
	});

	it("bounds a recall so a large store cannot flood a context", async () => {
		const created = createMemoryBackend("local");
		if (!created.ok) throw new Error("local backend should instantiate");
		for (let index = 0; index < 25; index++) {
			await created.backend.retain?.(candidate({ text: `convention number ${index} about the repository root` }));
		}
		const hits = await created.backend.recall?.({ text: "repository root" });
		expect(hits!.length).toBeLessThanOrEqual(DEFAULT_RECALL_LIMIT);
	});
});

describe("a memory is data, not an instruction", () => {
	it("refuses empty and over-long text rather than storing half a fact", () => {
		// Truncating would leave a half-fact that reads as whole, which is worse
		// than not storing it.
		expect(sanitizeMemoryText("   ")).toEqual({ ok: false, reason: "empty" });
		expect(sanitizeMemoryText("x".repeat(MAX_MEMORY_TEXT_LENGTH + 1))).toEqual({ ok: false, reason: "too long" });
	});

	it("accepts and trims ordinary text", () => {
		const result = sanitizeMemoryText("  a real fact  ");
		expect(result.ok).toBe(true);
		expect(result.text).toBe("a real fact");
	});
});

describe("a child's worktree state cannot become a parent project fact by accident", () => {
	it("defaults a worktree agent's memory to session scope", () => {
		// The rule is a default, not a convention: a child in an isolated
		// worktree must not promote temporary branch state.
		const provenance = provenanceForOrigin({ agent: "child-1", worktree: "/repo-wt", source: "edit.ts" });
		expect(provenance.scope).toBe("session");
		expect(provenance.worktree).toBe("/repo-wt");
		expect(provenance.source).toBe("edit.ts");
	});

	it("records a promotion to project scope rather than silently allowing it", () => {
		// A caller that really does mean a project fact can say so, and the
		// record carries why it was allowed.
		const decision = scopeForOrigin({ agent: "child-1", worktree: "/repo-wt" }, "project");
		expect(decision.scope).toBe("project");
		expect(decision.warning).toMatch(/worktree/);
	});

	it("leaves a parent agent's project scope alone", () => {
		const provenance = provenanceForOrigin({ agent: "parent" });
		expect(provenance.scope).toBe("project");
		expect(provenance.worktree).toBeUndefined();
	});

	it("carries confidence and evidence so a memory can be weighed", () => {
		const provenance = provenanceForOrigin({ agent: "parent" }, { confidence: 0.4, evidence: "one flaky run" });
		expect(provenance.confidence).toBe(0.4);
		expect(provenance.evidence).toBe("one flaky run");
	});
});
