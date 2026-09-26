import { describe, expect, it } from "vitest";
import { createModels, type Provider } from "../src/models.ts";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * End-to-end coverage for models that are reachable without provider credentials.
 *
 * These tests deliberately use the **real** `opencode` provider and the **real**
 * generated catalog rather than a hand-built double, so they exercise the actual
 * classification data (`access: "anonymous"` on `space-bunny-free`) and the real
 * `envApiKeyAuth`, which resolves to nothing without `OPENCODE_API_KEY`. Nothing
 * here special-cases a model id or a provider: the behaviour comes from
 * `Model.access` plus `isCredentialFree`.
 */

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

/** Minimal SSE body the OpenAI-compatible adapter can consume. */
function sseResponse(): Response {
	const body = [
		`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ok" } }] })}`,
		`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
		"data: [DONE]",
		"",
	].join("\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Captured {
	authorization: string | null;
	present: boolean;
}

/**
 * Runs a real request through the real SDK with only the network stubbed, so the
 * headers observed are the ones that would actually go on the wire.
 */
async function requestWithCapturedAuth(model: Parameters<Provider["streamSimple"]>[0]): Promise<Captured> {
	const models = createModels();
	models.setProvider(opencodeProvider());
	let captured: Captured = { authorization: null, present: false };
	const stubFetch: typeof globalThis.fetch = async (_input, init) => {
		const headers = new Headers(init?.headers);
		captured = { authorization: headers.get("authorization"), present: headers.has("authorization") };
		return sseResponse();
	};
	await models.streamSimple(model, context, { fetch: stubFetch }).result();
	return captured;
}

describe("credential-free models: availability", () => {
	it("exposes the anonymously served free model with no provider credentials", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());

		const available = await models.getAvailable();
		expect(available.map((m) => m.id)).toContain("space-bunny-free");
	});

	it("keeps credential-required free models unavailable without credentials", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());

		const available = await models.getAvailable();
		// `mimo-v2.5-free` is a real OpenCode free model that answers 403 without the
		// OpenCode client, so it must not be offered on reachability alone.
		expect(available.map((m) => m.id)).not.toContain("mimo-v2.5-free");
		// Nor may any paid model leak in through the anonymous path.
		expect(available.every((m) => m.access === undefined || m.access === "anonymous" || m.access === "local")).toBe(
			true,
		);
	});
});

describe("credential-free models: request preparation", () => {
	it("sends no Authorization header for an anonymous free model", async () => {
		const model = getModel("opencode", "space-bunny-free");
		const captured = await requestWithCapturedAuth(model);

		// The header must be absent entirely, not present-and-empty and not a
		// placeholder bearer token.
		expect(captured.present).toBe(false);
		expect(captured.authorization).toBeNull();
	});

	it("completes a real anonymous request against the model", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());
		const model = getModel("opencode", "space-bunny-free");

		const message = await models.streamSimple(model, context, { fetch: async () => sseResponse() }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
	});

	it("still rejects an ordinary credential-required OpenCode model", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());
		const paid = getModel("opencode", "claude-fable-5");
		let requests = 0;
		const countingFetch: typeof globalThis.fetch = async () => {
			requests++;
			return sseResponse();
		};

		const message = await models.streamSimple(paid, context, { fetch: countingFetch }).result();

		// The contract is that no request is attempted at all, not merely that it fails.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("opencode");
		expect(requests).toBe(0);
	});

	it("still rejects a credential-required free OpenCode model", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());
		const freeButCredentialed = getModel("opencode", "mimo-v2.5-free");
		// Precondition: this model really is free, so only reachability can exclude it.
		expect(freeButCredentialed.free).toBe(true);
		let requests = 0;
		const countingFetch: typeof globalThis.fetch = async () => {
			requests++;
			return sseResponse();
		};

		const message = await models.streamSimple(freeButCredentialed, context, { fetch: countingFetch }).result();

		expect(message.stopReason).toBe("error");
		expect(requests).toBe(0);
	});
});

describe("credential-free models: an operator-configured key still wins", () => {
	it("sends the configured key instead of suppressing the header", async () => {
		const models = createModels();
		models.setProvider(opencodeProvider());
		const model = getModel("opencode", "space-bunny-free");
		let authorization: string | null = null;
		const stubFetch: typeof globalThis.fetch = async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return sseResponse();
		};

		await models.streamSimple(model, context, { fetch: stubFetch, apiKey: "sk-configured" }).result();

		// Suppression is for the credential-free case only; an explicit key is used.
		expect(authorization).toBe("Bearer sk-configured");
	});
});
