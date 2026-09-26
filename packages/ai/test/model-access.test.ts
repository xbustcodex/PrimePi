import { describe, expect, it } from "vitest";
import { isAnonymouslyAccessible, isCredentialFree, withAccessFlag, withFreeFlag } from "../src/utils/free-model.ts";

describe("model access classification", () => {
	describe("withFreeFlag", () => {
		it("flags only explicit free markers, never zero cost", () => {
			expect(withFreeFlag({ id: "vendor/model:free", cost: { input: 5 } }).free).toBe(true);
			expect(withFreeFlag({ id: "vendor/model-free", cost: { input: 5 } }).free).toBe(true);
			expect(withFreeFlag({ id: "openrouter/free", cost: { input: 5 } }).free).toBe(true);
			// Paid model that happens to report zero cost must not be flagged free.
			expect(withFreeFlag({ id: "vendor/model", cost: { input: 0 } }).free).toBeUndefined();
		});
	});

	describe("isAnonymouslyAccessible", () => {
		it("is model-scoped, not provider-scoped", () => {
			expect(isAnonymouslyAccessible("opencode", "space-bunny-free")).toBe(true);
			// Same provider, different model: still needs the OpenCode client/login.
			expect(isAnonymouslyAccessible("opencode", "mimo-v2.5-free")).toBe(false);
			expect(isAnonymouslyAccessible("opencode", "claude-opus-5")).toBe(false);
			// Same model id, different provider: opencode-go answers 401 for it.
			expect(isAnonymouslyAccessible("opencode-go", "space-bunny-free")).toBe(false);
		});
	});

	describe("withAccessFlag", () => {
		it("tags only anonymously reachable models", () => {
			expect(withAccessFlag({ id: "space-bunny-free", provider: "opencode" }).access).toBe("anonymous");
			expect(withAccessFlag({ id: "claude-opus-5", provider: "opencode" }).access).toBeUndefined();
		});

		it("does not mark paid models as credential-free", () => {
			const tagged = withAccessFlag({ id: "space-bunny-free", provider: "opencode", cost: 0 });
			expect(tagged.access).toBe("anonymous");
			// free is decided independently and must not be inferred from access.
			expect(withFreeFlag(tagged).free).toBe(true);
			expect(withAccessFlag({ id: "opus", provider: "anthropic", cost: 5 }).access).toBeUndefined();
		});
	});

	describe("isCredentialFree", () => {
		it("treats anonymous and local as reachable without credentials", () => {
			expect(isCredentialFree({ access: "anonymous" })).toBe(true);
			expect(isCredentialFree({ access: "local" })).toBe(true);
		});

		it("treats unset and credentialed access as requiring credentials", () => {
			for (const access of [undefined, "unknown", "api-key", "login", "subscription"] as const) {
				expect(isCredentialFree({ access })).toBe(false);
			}
		});

		it("never infers reachability from price", () => {
			// A free model with no access classification still needs credentials.
			expect(isCredentialFree({ access: undefined })).toBe(false);
		});
	});
});
