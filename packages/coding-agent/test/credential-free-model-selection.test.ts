import { type Api, isCredentialFree, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * Model selection must accept a model that needs no credentials, even when its
 * provider has none configured, and must still reject ordinary models.
 *
 * These run against the real `ModelRuntime` and the real generated catalog, so the
 * `access: "anonymous"` classification on `opencode/space-bunny-free` is what makes
 * them pass. Nothing here special-cases that model id.
 */

function requireAvailable(session: AgentSession, id: string): Model<Api> {
	const found = session.modelRuntime.getAvailableSnapshot().find((model) => model.id === id);
	if (!found) throw new Error(`model ${id} is not in the available snapshot`);
	return found;
}

describe("setModel with credential-free models", () => {
	it("selects an anonymous free model when the provider has no credentials", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;

		// Precondition: the provider really has no configured auth, so only the model's
		// own classification can make this selectable.
		expect(runtime.hasConfiguredAuth("opencode")).toBe(false);
		const model = requireAvailable(harness.session, "space-bunny-free");
		expect(model.free).toBe(true);
		expect(model.access).toBe("anonymous");

		await expect(harness.session.setModel(model)).resolves.toBeUndefined();
		expect(harness.session.model?.id).toBe("space-bunny-free");
	});

	it("still rejects an ordinary OpenCode model with no credentials", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		expect(harness.session.modelRuntime.hasConfiguredAuth("opencode")).toBe(false);

		const paid = harness.session.modelRuntime.getModel("opencode", "claude-fable-5");
		expect(paid).toBeDefined();

		await expect(harness.session.setModel(paid!)).rejects.toThrow(/No API key for opencode/);
	});

	it("keeps an ordinary OpenCode model out of the available snapshot without credentials", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		const snapshot = harness.session.modelRuntime.getAvailableSnapshot();

		// Availability is the first gate: an uncredentialed provider contributes only
		// its credential-free models.
		expect(snapshot.some((model) => model.id === "space-bunny-free")).toBe(true);
		expect(snapshot.some((model) => model.id === "claude-fable-5")).toBe(false);
	});

	it("does not mark an anonymous model as missing credentials for failover", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		const runtime = harness.session.modelRuntime;
		const model = requireAvailable(harness.session, "space-bunny-free");

		// This is the exact predicate the failover candidate producer uses. A
		// credential-free model must never be reported as unreachable just because its
		// provider has no key.
		const credentialMissing = !isCredentialFree(model) && !runtime.hasConfiguredAuth(model.provider);
		expect(credentialMissing).toBe(false);

		// Contrast case, so the assertion above is not vacuous.
		const paid = runtime.getModel("opencode", "claude-fable-5")!;
		expect(!isCredentialFree(paid) && !runtime.hasConfiguredAuth(paid.provider)).toBe(true);
	});
});
