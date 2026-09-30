/**
 * Adversarial tests for memory deduplication.
 *
 * The real PD-9 findings showed that lexical similarity alone is insufficient:
 * two claims can share almost every word and still be opposites. Each case here
 * is a pair of statements that differ *only* in the way listed, and the
 * assertion is that they are NOT deduplicated.
 *
 * The failure these guard is specific and expensive: a corrected fact
 * disappearing because it looked like the stale one it corrects. The user then
 * keeps acting on the wrong value, with no error anywhere.
 *
 * Where two claims genuinely conflict, the answer is the contradiction path, not
 * a duplicate rejection. These tests therefore assert the *distinctness* of the
 * pair, leaving it to the supersession machinery to decide which is current.
 */

import { describe, expect, it } from "vitest";
import { isSameFact } from "../src/core/memory/retention.ts";

/** Asserts two claims are treated as different facts. */
function distinct(a: string, b: string, why: string): void {
	expect(isSameFact(a, b), `${why}\n  A: ${a}\n  B: ${b}`).toBe(false);
}

describe("claims that differ only in a number", () => {
	it("keeps a corrected duration", () => {
		distinct(
			"The failover cooldown for a provider scope is 90 seconds",
			"The failover cooldown for a provider scope is 30 seconds",
			"the number is the claim",
		);
	});

	it("keeps a corrected limit", () => {
		distinct("The default recall limit is 10 memories", "The default recall limit is 5 memories", "limit changed");
	});

	it("keeps a corrected port", () => {
		distinct(
			"The engine listens on port 7777 for local access",
			"The engine listens on port 8888 for local access",
			"port changed",
		);
	});

	it("keeps a corrected timeout", () => {
		distinct(
			"The request timeout is 15000 milliseconds",
			"The request timeout is 30000 milliseconds",
			"timeout changed",
		);
	});

	it("still merges a reworded claim with identical numbers", () => {
		expect(
			isSameFact(
				"The failover cooldown for a provider scope is 90 seconds",
				"A provider-scope failover cooldown of 90 seconds applies",
			),
		).toBe(true);
	});
});

describe("claims that differ only in a version or path", () => {
	it("keeps a corrected dependency version", () => {
		distinct(
			"The build requires numpy 1.26.0 or newer",
			"The build requires numpy 2.2.6 or newer",
			"version changed",
		);
	});

	it("keeps a corrected path separator", () => {
		distinct(
			"Windows path separators are backslashes throughout",
			"Windows path separators are forward slashes throughout",
			"path semantics reversed",
		);
	});

	it("keeps a corrected file location", () => {
		distinct(
			"The store is written to the agent memory directory by default",
			"The store is written to the session memory directory by default",
			"location changed",
		);
	});
});

describe("claims that differ only in a boolean or an enablement", () => {
	it("keeps a corrected enabled state", () => {
		distinct(
			"Auto recall is enabled for the first turn of each session",
			"Auto recall is disabled for the first turn of each session",
			"enabled flipped",
		);
	});

	it("keeps a corrected encryption claim", () => {
		distinct(
			"The engine encrypts every file under the store root at rest",
			"The engine encrypts only the store and the index at rest",
			"scope narrowed by the proof",
		);
	});
});

describe("claims that differ only in a name", () => {
	it("keeps a corrected method name", () => {
		distinct(
			"The stdio server entry point is iai_mcp.core:main",
			"The stdio server entry point is iai_mcp.cli:main",
			"entry point corrected",
		);
	});

	it("keeps a corrected provider name", () => {
		distinct(
			"Failover prefers the OpenRouter route for free models",
			"Failover prefers the OpenCode route for free models",
			"provider changed",
		);
	});

	it("keeps a corrected setting key", () => {
		distinct(
			"The setting that selects the memory backend is memory.backend",
			"The setting that selects the memory backend is memory.store",
			"key renamed",
		);
	});
});

describe("claims that are negations of each other", () => {
	it("keeps a negated capability", () => {
		distinct(
			"The engine supports an initialize handshake before dispatch",
			"The engine does not support an initialize handshake before dispatch",
			"one is the negation of the other",
		);
	});

	it("keeps a negated invariant", () => {
		distinct(
			"The bank identity is derived from the enclosing git root",
			"The bank identity is not derived from the enclosing git root",
			"negated",
		);
	});

	it("keeps a supports versus does-not-support pair", () => {
		distinct(
			"Mnemopi supports tag filtered recall",
			"Mnemopi does not support tag filtered recall",
			"capability reversed",
		);
	});

	it("keeps an is versus is-not pair", () => {
		distinct(
			"Recall preserves the engine assigned score",
			"Recall does not preserve the engine assigned score",
			"reversed",
		);
	});
});

describe("genuinely identical claims still merge", () => {
	it("merges a reworded identical claim", () => {
		expect(
			isSameFact(
				"The bank identity derives from the absolute path",
				"The bank identity is derived from the absolute path",
			),
		).toBe(true);
	});

	it("merges a claim that differs only in punctuation and case", () => {
		expect(isSameFact("The engine is local-only.", "the engine is local only")).toBe(true);
	});

	it("keeps two facts about different subjects apart", () => {
		distinct(
			"The provider cooldown is 90 seconds for a provider scope",
			"The model cooldown is 30 seconds for a model scope",
			"different subject and value",
		);
	});
});
