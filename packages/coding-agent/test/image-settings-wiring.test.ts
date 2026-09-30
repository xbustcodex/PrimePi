import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, type Message, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * What `images.autoResize` and `images.blockImages` do to a request that leaves.
 *
 * ## Why assert on the captured provider request
 *
 * Both settings govern what the provider is handed. `images.autoResize` decides
 * the size of the bytes; `images.blockImages` decides whether image blocks are
 * present at all. Asserting on either tool's return value would prove the tool
 * did its own arithmetic while saying nothing about whether that arithmetic
 * reached the wire — which is precisely the failure this suite exists to catch,
 * and precisely what the ledger got wrong about these two rows.
 *
 * The capture point is `streamSimple`'s `context.messages`: the exact array the
 * provider receives. Everything upstream of it (prompt normalisation, the
 * `convertToLlm` wrapper, the agent loop) is the production path, because the
 * session under test is built by `createAgentSession`, the same function
 * `main.ts` reaches through `createAgentSessionFromServices`.
 *
 * ## Why settings come from a written file
 *
 * `SettingsManager.inMemory({...})` takes an already-shaped object, so it proves
 * the accessor reads a field — not that a user's `settings.json` produces that
 * field. These tests write `settings.json` and let `SettingsManager.create` parse
 * it, so the descriptor's own parse and default are in the path. A key that
 * could not be written is a key whose absence would go unnoticed.
 *
 * ## The resize profile is the model's, not a test constant
 *
 * A 100x100 PNG is far inside the 2000x2000 default, so `autoResize` on would
 * leave it byte-identical and the two settings would be indistinguishable. The
 * profile is attached to the model the way a real vision model carries one
 * (`inputLimits.images.resize`), and `_normalizePromptImages` reads it from
 * there — so the resize the test observes is the resize the product performs
 * for a model with small inline limits, not a limit invented for the test.
 */

/** A 100x100 PNG. Inside the 2000x2000 default, above every limit set below. */
const PNG_100x100 =
	"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAAAAABVicqIAAAAAmJLR0QA/4ePzL8AAAAHdElNRQfqAQ4AMzkN2iH/AAAAP0lEQVRo3u3NQQEAAAQEMASXXYrz2gqst/Lm4ZBIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiSTsAP1cAUZeKtreAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAw6crMeAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMJiXdMQAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDPglUbAAAAAElFTkSuQmCC";

/** Well under the PNG's 404 base64 characters, so any resize must shrink it. */
const TINY_RESIZE_PROFILE = { maxWidth: 10, maxHeight: 10, maxBytes: 5_000, jpegQuality: 70 };

function createModel(api: Api): Model<Api> {
	return {
		id: "vision-model",
		name: "Vision Model",
		api,
		provider: "capture-provider",
		baseUrl: "https://capture.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		inputLimits: { images: { resize: TINY_RESIZE_PROFILE } },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function doneStream(api: Api) {
	const stream = createAssistantMessageEventStream();
	stream.end({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api,
		provider: "capture-provider",
		model: "vision-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return stream;
}

describe("the image settings reach the request that leaves", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-image-settings-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Runs one turn through the production session and returns the messages the
	 * provider was handed.
	 *
	 * `settings` is written to `settings.json` rather than injected, so the
	 * descriptor's parse and default decide what the session sees.
	 */
	async function sendImageTurn(settings: Record<string, unknown>): Promise<Message[]> {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		const model = createModel("capture-api");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const captured: Message[][] = [];
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_requestModel, context) => {
				captured.push(structuredClone(context.messages));
				return doneStream(model.api);
			},
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		});

		try {
			await session.prompt("what is in this image?", {
				images: [{ type: "image", data: PNG_100x100, mimeType: "image/png" }],
			});
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}

		expect(captured).toHaveLength(1);
		return captured[0];
	}

	/** Every image block in the request, in order. */
	function imageBlocks(messages: readonly Message[]): { data: string; mimeType: string }[] {
		const blocks: { data: string; mimeType: string }[] = [];
		for (const message of messages) {
			if (message.role === "user" || message.role === "toolResult") {
				if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "image") blocks.push({ data: block.data, mimeType: block.mimeType });
					}
				}
			}
		}
		return blocks;
	}

	function allText(messages: readonly Message[]): string {
		const parts: string[] = [];
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") parts.push(block.text);
				}
			}
		}
		return parts.join("\n");
	}

	describe("images.autoResize", () => {
		it("attaches the original bytes when the setting is off", async () => {
			// Written as the user writes it: an explicit `false` in settings.json.
			const messages = await sendImageTurn({ images: { autoResize: false } });
			const images = imageBlocks(messages);
			expect(images).toHaveLength(1);
			expect(images[0].data).toBe(PNG_100x100);
		});

		it("attaches different, smaller bytes when the setting is on", async () => {
			// Absent from settings.json, so the descriptor default (`true`) decides.
			const messages = await sendImageTurn({});
			const images = imageBlocks(messages);
			expect(images).toHaveLength(1);
			expect(images[0].data).not.toBe(PNG_100x100);
			// A same-size re-encode would satisfy "different"; a shrink is the claim.
			expect(images[0].data.length).toBeLessThan(PNG_100x100.length);
		});

		it("reports the scale it applied, so coordinates stay meaningful", async () => {
			// A resized image the model is not told about has wrong coordinates.
			const messages = await sendImageTurn({});
			expect(allText(messages)).toMatch(/original 100x100, displayed at 10x10/);
		});

		it("keeps the image when the resize cannot shrink it below the limit", async () => {
			// A resize budget no image can meet must not silently drop the
			// attachment: the model asked a question about a picture.
			const messages = await sendImageTurn({ images: { autoResize: true } });
			expect(imageBlocks(messages)).toHaveLength(1);
		});
	});

	describe("images.blockImages", () => {
		it("replaces the image with a note when the setting is on", async () => {
			const messages = await sendImageTurn({ images: { blockImages: true } });
			expect(imageBlocks(messages)).toHaveLength(0);
			expect(allText(messages)).toContain("Image reading is disabled.");
		});

		it("attaches the image when the setting is off", async () => {
			// Absent, so the descriptor default (`false`) decides. A user who has
			// never heard of the setting must get images.
			const messages = await sendImageTurn({});
			expect(imageBlocks(messages)).toHaveLength(1);
		});

		it("keeps the question the user actually asked", async () => {
			// Blocking images must not cost the user their prompt.
			const messages = await sendImageTurn({ images: { blockImages: true } });
			expect(allText(messages)).toContain("what is in this image?");
		});
	});

	describe("the two together", () => {
		it("blocks the image whether or not resizing would have shrunk it", async () => {
			// Resizing is upstream of the block, so the block must be the last word:
			// a resize cannot smuggle an image past it by making the image smaller.
			const blockedResized = await sendImageTurn({ images: { blockImages: true, autoResize: true } });
			expect(imageBlocks(blockedResized)).toHaveLength(0);

			const blockedOriginal = await sendImageTurn({ images: { blockImages: true, autoResize: false } });
			expect(imageBlocks(blockedOriginal)).toHaveLength(0);
		});
	});
});
