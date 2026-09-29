import { describe, expect, it } from "vitest";
import {
	describeRetrievalMode,
	planRetrieval,
	type RetrievalConfig,
	resolveRetrievalMode,
	retrievalCaveat,
} from "../src/core/memory/retrieval-mode.ts";

/**
 * Retrieval mode.
 *
 * The property that matters most: **an explicitly configured endpoint is
 * authoritative.** A role selection supplies only the managed-model path, and
 * must never repoint a user who configured their own instance.
 */

const config = (overrides: Partial<RetrievalConfig> = {}): RetrievalConfig => ({
	noEmbeddings: false,
	...overrides,
});

describe("the mode follows the settings", () => {
	it("is vector by default", () => {
		expect(resolveRetrievalMode(config())).toBe("vector");
	});

	it("is full-text when embeddings are disabled", () => {
		// Lexical recall, not "cheaper vector recall": it finds the words a memory
		// uses, not the meaning.
		expect(resolveRetrievalMode(config({ noEmbeddings: true }))).toBe("fts");
	});

	it("is none when recall is disabled outright", () => {
		// Disabling is not degrading. A user who has decided memory should not
		// influence the conversation gets that, not a worse version of it.
		expect(resolveRetrievalMode(config({ llmMode: "none" }))).toBe("none");
	});

	it("prefers none over fts, because disabling recall wins", () => {
		expect(resolveRetrievalMode(config({ noEmbeddings: true, llmMode: "none" }))).toBe("none");
	});
});

describe("a configured endpoint is authoritative", () => {
	it("is used rather than a managed model", () => {
		// A user who configured their own instance must not have it repointed
		// because a model role happened to resolve first.
		const plan = planRetrieval(config({ llmBaseUrl: "https://mine.internal" }), { resolvedKey: "managed-key" });
		expect(plan.endpoint).toBe("https://mine.internal");
		expect(plan.credentialSource).toBe("configured");
	});

	it("treats a blank endpoint as unconfigured", () => {
		const plan = planRetrieval(config({ llmBaseUrl: "   " }), { resolvedKey: "managed-key" });
		expect(plan.endpoint).toBeUndefined();
		expect(plan.credentialSource).toBe("resolved-from-model");
	});

	it("falls back to a managed credential only when none is configured", () => {
		expect(planRetrieval(config(), { resolvedKey: "k" }).endpoint).toBeUndefined();
		expect(planRetrieval(config(), { resolvedKey: "k" }).credentialSource).toBe("resolved-from-model");
	});

	it("uses nothing when no endpoint and no credential exist", () => {
		const plan = planRetrieval(config());
		expect(plan.credentialSource).toBeUndefined();
	});
});

describe("remote mode without an endpoint is a configuration error", () => {
	it("warns rather than silently using a local one", () => {
		// Silently falling back would look like it worked.
		const plan = planRetrieval(config({ llmMode: "remote" }));
		expect(plan.warning).toContain("remote mode");
		expect(plan.reason).toContain("no endpoint is configured");
	});

	it("does not warn when an endpoint is supplied", () => {
		expect(planRetrieval(config({ llmMode: "remote", llmBaseUrl: "https://x" })).warning).toBeUndefined();
	});
});

describe("disabling recall is reported, not hidden", () => {
	it("says memory does not reach the conversation", () => {
		const plan = planRetrieval(config({ llmMode: "none" }));
		expect(plan.mode).toBe("none");
		expect(plan.reason).toContain("no memory reaches the conversation");
	});

	it("warns that retention is not stopped by disabling recall", () => {
		// A local store keeps records whether or not recall is asked for, so
		// disabling only stops the query, not the retention.
		expect(planRetrieval(config({ llmMode: "none" })).warning).toContain("cannot be asked to stop retrieving");
	});
});

describe("the mode is described honestly", () => {
	it("distinguishes lexical recall from semantic", () => {
		expect(describeRetrievalMode("fts")).toContain("not the meaning");
		expect(describeRetrievalMode("vector")).toContain("Semantic");
		expect(describeRetrievalMode("none")).toContain("does not influence");
	});

	it("marks a lexical result so it is not read as most-relevant", () => {
		// A full-text hit is an exact term match; saying so stops a model reading a
		// lexical top hit as the most relevant memory rather than the most
		// lexically similar one.
		expect(retrievalCaveat("fts")).toContain("lexical similarity, not meaning");
		expect(retrievalCaveat("vector")).toBeUndefined();
		expect(retrievalCaveat("none")).toBeUndefined();
	});
});
