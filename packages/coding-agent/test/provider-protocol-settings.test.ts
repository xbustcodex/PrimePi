/**
 * `providers.*` protocol settings: the join between a typed setting and the
 * request that leaves the process.
 *
 * ## What each test drives
 *
 * Every case goes through `createAgentSession` — the function a real `pi` run
 * calls — and then through the session's `Agent` `streamFn`, which is the only
 * place `buildRequestOptions`, and therefore `applyProviderProtocolSettings`, is
 * invoked. The provider registered on the `ModelRuntime` is not a stub that
 * records options and returns: it calls the real `packages/ai` Responses
 * adapter, with a fake `fetch` standing in for the network. So the thing under
 * test is the whole chain, not a helper.
 *
 * That matters because the failure this file exists to catch is a *seam*
 * failure: `applyProviderProtocolSettings` and the adapter each work in
 * isolation, and a setting dropped between them passes every unit test while
 * governing nothing.
 *
 * ## How settings are obtained (and why)
 *
 * Through a file-backed `SettingsManager` and `setSetting`, which routes the
 * value through the descriptor's `parse`. Injecting an already-parsed settings
 * object would prove only that the resolver honours a value, not that a user can
 * write one — two independent failure layers, each of which survives the other's
 * tests.
 *
 * Settings are changed *between* prompts on one live session rather than by
 * building a new session per case, because "a settings change takes effect on the
 * next request" is the claim being made; a fresh session would prove it for a
 * fresh session only.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Model as AiModel,
	AvailabilityCooldowns,
	policyAllowsPaid,
	selectFailoverCandidate,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const SECRET_API_KEY = "sk-super-secret-protocol-key";
const MODEL_ID = "anthropic/claude-haiku-4.5";

/** The opening SSE frame: a text delta, so the stream is genuinely running. */
const SSE_HEAD = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`;

/** The closing frame, which is what ends a Responses turn without an error. */
const SSE_TAIL = `data: ${JSON.stringify({
	type: "response.completed",
	response: {
		status: "completed",
		usage: {
			input_tokens: 5,
			output_tokens: 3,
			total_tokens: 8,
			input_tokens_details: { cached_tokens: 0 },
		},
	},
})}\n\n`;

/**
 * A response body the test releases.
 *
 * `head` goes out immediately, so the stream is running and the first-event
 * watchdog is satisfied; the tail only goes out when the test says so, which is
 * what makes the gap between the two a real idle gap.
 */
function releasableSse(head = SSE_HEAD): {
	body: ReadableStream<Uint8Array>;
	release: (tail?: string) => void;
} {
	const encoder = new TextEncoder();
	let released = false;
	let releaseTail: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(head));
			releaseTail = () => {
				// The watchdog may already have errored and cancelled this body; a
				// release after that is a no-op, not a failure.
				if (released) return;
				released = true;
				try {
					controller.enqueue(encoder.encode(SSE_TAIL));
					controller.close();
				} catch {}
			};
		},
	});
	return {
		body,
		release: (tail?: string) => {
			void tail;
			releaseTail?.();
		},
	};
}

/** A body that completes on its own, for cases where only the request matters. */
function completedSse(): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`${SSE_HEAD}${SSE_TAIL}`));
			controller.close();
		},
	});
}

function openRouterModel(): AiModel<"openai-responses"> {
	return {
		id: MODEL_ID,
		name: "Claude Haiku 4.5",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		compat: { supportsLongCacheRetention: true },
	} as AiModel<"openai-responses">;
}

interface ProtocolHarness {
	session: AgentSession;
	/** Every payload the adapter was about to send, in order. */
	payloads: Record<string, unknown>[];
	/** The option set the session handed the provider on the most recent request. */
	lastOptions: Record<string, unknown> | undefined;
	/**
	 * Installs the body the next request is served and returns a promise that
	 * resolves once the transport has asked for it.
	 */
	serveNextWith: (factory: () => ReadableStream<Uint8Array>) => Promise<void>;
}

describe("providers.* protocol settings", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let modelRuntime: ModelRuntime | undefined;
	let harness: ProtocolHarness | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-provider-protocol-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// File-backed, so a value written here is written the way a user writes it:
		// through the descriptor's `parse`.
		settingsManager = SettingsManager.create(tempDir, agentDir);
	});

	afterEach(async () => {
		await harness?.session.dispose();
		harness = undefined;
		vi.unstubAllGlobals();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Builds a live session whose provider is the real Responses adapter plus a
	 * caller-supplied `fetch`.
	 *
	 * The provider is deliberately thin: it adds the fake transport and an
	 * `onPayload` capture and passes every other option through untouched, so
	 * whatever the session produced is what the adapter sees.
	 */
	async function startHarness(): Promise<ProtocolHarness> {
		const model = openRouterModel();
		const payloads: Record<string, unknown>[] = [];
		let nextBody: () => ReadableStream<Uint8Array> = completedSse;
		let bodyRequested: (() => void) | undefined;
		let lastOptions: Record<string, unknown> | undefined;

		const auth = AuthStorage.inMemory();
		await auth.modify("openrouter", async () => ({ type: "api_key", key: SECRET_API_KEY }));
		modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerProvider("openrouter", {
			baseUrl: model.baseUrl,
			apiKey: SECRET_API_KEY,
			api: "openai-responses",
			models: [
				{
					id: model.id,
					name: model.name,
					api: "openai-responses",
					reasoning: false,
					input: ["text"],
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				},
			],
			streamSimple: (streamModel, context, options) => {
				lastOptions = { ...options } as Record<string, unknown>;
				return streamSimpleOpenAIResponses(streamModel as AiModel<"openai-responses">, context, {
					...options,
					fetch: (async () => {
						const body = nextBody();
						bodyRequested?.();
						bodyRequested = undefined;
						return new Response(body, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						});
					}) as typeof globalThis.fetch,
					onPayload: async (payload) => {
						payloads.push(payload as Record<string, unknown>);
						return options?.onPayload?.(payload, streamModel);
					},
				});
			},
		});

		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			modelRuntime,
			resourceLoader,
		});
		return {
			session,
			payloads,
			get lastOptions() {
				return lastOptions;
			},
			/**
			 * Installs the body the next request will be served, and returns a promise
			 * that resolves once the transport has actually asked for it. Created here,
			 * before the prompt starts, so there is no window in which the request could
			 * arrive before anyone is listening for it.
			 */
			serveNextWith: (factory) => {
				nextBody = factory;
				// `Promise.withResolvers` is the tidier form, but this package's test
				// lib predates it, so the deferred is spelled out.
				const arrival: { resolve: () => void } = { resolve: () => {} };
				const promise = new Promise<void>((resolve) => {
					arrival.resolve = resolve;
				});
				bodyRequested = arrival.resolve;
				return promise;
			},
		};
	}

	it("appends the routing variant to the outgoing model id, and sends no suffix for default", async () => {
		harness = await startHarness();
		const first = harness.serveNextWith(completedSse);

		settingsManager.setSetting("providers.openrouterVariant", "nitro", "global");
		await harness.session.prompt("say hello");
		await first;
		expect(harness.payloads.at(-1)?.model).toBe(`${MODEL_ID}:nitro`);

		// `default` is the reference's own "no suffix" token. Forwarding it verbatim
		// would ask OpenRouter for a variant that does not exist.
		settingsManager.setSetting("providers.openrouterVariant", "default", "global");
		const second = harness.serveNextWith(completedSse);
		await harness.session.prompt("say hello again");
		await second;
		expect(harness.payloads.at(-1)?.model).toBe(MODEL_ID);
	});

	it("changes the cache TTL the provider is asked for, and defers to the provider on auto", async () => {
		harness = await startHarness();
		const third = harness.serveNextWith(completedSse);

		settingsManager.setSetting("providers.cacheRetention", "long", "global");
		await harness.session.prompt("say hello");
		await third;
		expect(harness.payloads.at(-1)?.prompt_cache_retention).toBe("24h");
		expect(harness.payloads.at(-1)?.prompt_cache_key).toBeDefined();

		settingsManager.setSetting("providers.cacheRetention", "none", "global");
		const fourth = harness.serveNextWith(completedSse);
		await harness.session.prompt("say hello again");
		await fourth;
		expect(harness.payloads.at(-1)?.prompt_cache_retention).toBeUndefined();
		expect(harness.payloads.at(-1)?.prompt_cache_key).toBeUndefined();

		// `auto` is a decision to defer, not a fourth retention, so the adapter's
		// own short default applies and no long TTL is requested.
		settingsManager.setSetting("providers.cacheRetention", "auto", "global");
		const fifth = harness.serveNextWith(completedSse);
		await harness.session.prompt("say hello a third time");
		await fifth;
		expect(harness.payloads.at(-1)?.prompt_cache_retention).toBeUndefined();
	});

	describe("stream watchdogs", () => {
		/**
		 * @param idleSeconds the value written to `providers.streamIdleTimeoutSeconds`
		 * @param mode `raised` waits past the gap before releasing the stream;
		 * `lowered` never releases it and expects the watchdog to end the turn.
		 */
		async function runTurn(
			idleSeconds: number,
			mode: "raised" | "lowered",
		): Promise<{ stopReason: string; errorMessage: string }> {
			if (!harness) throw new Error("harness not started");
			const stream = releasableSse();
			const arrived = harness.serveNextWith(() => stream.body);
			settingsManager.setSetting("providers.streamIdleTimeoutSeconds", idleSeconds, "global");

			const pending = harness.session.prompt("say hello");
			// The transport has the body and its first frame is already out, so the
			// silence that follows is an idle gap and not a connect delay.
			await arrived;
			if (mode === "raised") {
				// Deliberate real-time check, and the only one in this file: the claim
				// under test is that a 30s budget does not fire, so the observation has
				// to be made against the platform clock. Fake timers cannot express it.
				const settled = { done: false };
				void pending.then(() => {
					settled.done = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(settled.done).toBe(false);
				stream.release();
			}
			await pending;
			const last = harness.session.messages.filter((m) => m.role === "assistant").at(-1) as
				| { stopReason?: string; errorMessage?: string }
				| undefined;
			return { stopReason: last?.stopReason ?? "", errorMessage: last?.errorMessage ?? "" };
		}

		it(
			"survives a quiet stream when the user raised the idle budget and aborts when they lowered it",
			{ timeout: 30_000 },
			async () => {
				harness = await startHarness();
				// The idle budget is spent in real time — a raised budget means the harness
				// waits that long before the stream may complete. Five seconds is enough to
				// prove the point (longer than the default, shorter than the suite) and keeps
				// the test from being a 30-second sleep that times out at the 5s default.
				const raised = await runTurn(5, "raised");
				expect(raised.stopReason).toBe("stop");

				const lowered = await runTurn(0.05, "lowered");
				// The stall ends the turn as a failure, which is the behaviour the setting
				// exists to produce. The text the user sees is the SDK's generic connection
				// message, because the OpenAI SDK wraps any body-read error; the watchdog's
				// own test asserts the message it raises.
				expect(lowered.stopReason).toBe("error");
				expect(lowered.errorMessage).not.toContain(SECRET_API_KEY);
				expect(lowered.errorMessage).not.toContain("Bearer");
			},
		);
	});

	it("serves a completing body by default, so a case about the request does not hang", async () => {
		harness = await startHarness();
		await harness.session.prompt("say hello");
		expect(harness.payloads).toHaveLength(1);
	});
	describe("authorities these settings must not touch", () => {
		it("leaves a disabled provider disabled with every protocol setting at its widest", async () => {
			harness = await startHarness();
			settingsManager.setSetting("providers.openaiWebsockets", "on", "global");
			settingsManager.setSetting("providers.cacheRetention", "long", "global");
			settingsManager.setSetting("providers.openrouterVariant", "exacto", "global");
			settingsManager.setSetting("providers.streamIdleTimeoutSeconds", 1, "global");
			settingsManager.setSetting("disabledProviders", ["openrouter"], "global");

			await harness.session.prompt("say hello");

			const available = harness.session.modelRuntime.getAvailableSnapshot();
			expect(available.some((m) => m.provider === "openrouter")).toBe(false);
		});

		it("cannot widen model eligibility: a paid model stays unreachable under free-only", async () => {
			harness = await startHarness();
			// Every protocol setting at its widest, on a live session.
			settingsManager.setSetting("providers.openaiWebsockets", "on", "global");
			settingsManager.setSetting("providers.cacheRetention", "long", "global");
			settingsManager.setSetting("providers.openrouterVariant", "exacto", "global");
			settingsManager.setSetting("providers.streamFirstEventTimeoutSeconds", 1, "global");
			settingsManager.setSetting("providers.streamIdleTimeoutSeconds", 1, "global");
			await harness.session.prompt("say hello");

			// What the protocol layer contributed is a description of a request. It
			// cannot name a model, pick a provider, or supply a credential, so it is not
			// an input to eligibility however it is set. The credential on the request
			// comes from auth alone, and is identical with the settings wide or narrow.
			const withSettingsWide = { ...harness.lastOptions };

			settingsManager.setSetting("providers.openaiWebsockets", "auto", "global");
			settingsManager.setSetting("providers.cacheRetention", "auto", "global");
			settingsManager.setSetting("providers.openrouterVariant", "default", "global");
			settingsManager.setSetting("providers.streamFirstEventTimeoutSeconds", -1, "global");
			settingsManager.setSetting("providers.streamIdleTimeoutSeconds", -1, "global");
			await harness.session.prompt("say hello again");
			expect(harness.lastOptions?.apiKey).toBe(withSettingsWide.apiKey);
			expect(harness.lastOptions?.apiKey).toBe(SECRET_API_KEY);

			// And the authority itself is unchanged: free stays free.
			const free = { ...openRouterModel(), id: "free/model", free: true } as AiModel<"openai-responses">;
			const paid = { ...openRouterModel(), id: "paid/model", free: false } as AiModel<"openai-responses">;
			expect(policyAllowsPaid("free-only")).toBe(false);
			const decision = selectFailoverCandidate({
				failed: free,
				policy: "free-only",
				candidates: [{ model: paid }],
				requirements: {},
				cooldowns: new AvailabilityCooldowns(),
				attempted: new Set(),
				now: 1_000,
			});
			expect("unavailable" in decision).toBe(true);
			if ("unavailable" in decision && decision.unavailable.kind === "exhausted") {
				expect(decision.unavailable.freeRequired).toBe(true);
				expect(decision.unavailable.blocked.join(" ")).toContain("not free");
			}
		});
	});
});
