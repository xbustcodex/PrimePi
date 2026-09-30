import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { SettingsManager } from "../src/core/settings-manager.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shareSession", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps concurrent session exports isolated", async () => {
		const uploads: string[] = [];
		childProcessMocks.spawn.mockImplementation((_command, args: string[]) => {
			uploads.push(readFileSync(args.at(-1)!, "utf8"));
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end(`https://gist.github.com/test/${uploads.length}\n`);
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});

		const aWritten = deferred();
		const bWritten = deferred();
		const releaseB = deferred();
		const errors: string[] = [];
		const context = (name: "A" | "B") => ({
			session: {
				sessionManager: {
					getSessionId: () => name,
					getCwd: () => "/tmp",
					getBranch: () => [],
				},
				settingsManager: SettingsManager.inMemory(),
				state: { systemPrompt: name, tools: [] },
				modelRuntime: { getProvider: () => undefined },
				exportToHtml: async (filePath: string) => {
					writeFileSync(filePath, name);
					if (name === "A") {
						aWritten.resolve();
						await bWritten.promise;
					} else {
						bWritten.resolve();
						await releaseB.promise;
					}
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus() {},
			showError(message: string) {
				errors.push(message);
			},
		});

		const shareA = shareSession(context("A") as never);
		await aWritten.promise;
		const shareB = shareSession(context("B") as never);
		await bWritten.promise;
		await shareA;
		releaseB.resolve();
		await shareB;

		expect(uploads).toEqual(["A", "B"]);
		expect(errors).toEqual([]);
	});
});

/**
 * Outbound redaction.
 *
 * These drive the real `shareSession` — the one function through which session
 * content leaves the machine — and assert on the bytes that actually reach the
 * upload, not on a helper. A redactor that is correct in isolation and never
 * called is worth nothing, and the only way to tell the difference is to read
 * what went out.
 */
describe("shareSession outbound redaction", () => {
	/** A credential-shaped token with real entropy, as a leaked one would have. */
	const PASTED_TOKEN = "ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xyZ";
	const ENV_SECRET = "s3cr3t-deploy-value";
	/** Whatever each touched variable held before, so a real one is put back. */
	const priorEnv = new Map<string, string | undefined>();

	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		for (const [name, value] of priorEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		priorEnv.clear();
		vi.unstubAllGlobals();
	});

	function setEnv(name: string, value: string): void {
		if (!priorEnv.has(name)) priorEnv.set(name, process.env[name]);
		process.env[name] = value;
	}

	interface ShareRun {
		/** Every byte string handed to an uploader, in order. */
		uploads: string[];
		errors: string[];
		statuses: string[];
		run: () => Promise<void>;
	}

	/**
	 * A share whose published content is `body`, uploaded over the Radius path so
	 * the assertion is on the bytes that cross the network.
	 */
	function shareViaRadius(body: string, settings = SettingsManager.inMemory(), cwd = "/projects/app"): ShareRun {
		const uploads: string[] = [];
		const errors: string[] = [];
		const statuses: string[] = [];
		vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
			uploads.push(Buffer.from(init.body as Uint8Array).toString("utf8"));
			return {
				ok: true,
				status: 200,
				json: async () => ({ artifact: { canonical_url: "https://radius.test/a/1" } }),
			};
		});
		const context = {
			session: {
				sessionManager: {
					getSessionId: () => "s1",
					getCwd: () => cwd,
					getBranch: () => [{ id: "e1", message: { role: "user", content: body } }],
				},
				settingsManager: settings,
				state: { systemPrompt: "", tools: [] },
				modelRuntime: {
					getProvider: () => ({}),
					getAuth: async () => ({ auth: { apiKey: "radius-token" } }),
				},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
		};
		return { uploads, errors, statuses, run: () => shareSession(context as never) };
	}

	it("masks a configured credential in what it publishes, and does not when secrets are off", async () => {
		setEnv("DEPLOY_TOKEN", ENV_SECRET);
		const body = `deploying with ${ENV_SECRET} now`;

		const redacting = shareViaRadius(body);
		await redacting.run();
		expect(redacting.errors).toEqual([]);
		expect(redacting.uploads).toHaveLength(1);
		expect(redacting.uploads[0]).not.toContain(ENV_SECRET);
		expect(redacting.uploads[0]).toContain("*".repeat(ENV_SECRET.length));
		// The rest of the line is untouched: a mask replaces the credential, not
		// the sentence that happened to contain it.
		expect(redacting.uploads[0]).toContain("deploying with ");
		expect(redacting.uploads[0]).toContain(" now");

		const disabled = SettingsManager.inMemory();
		disabled.setSetting("secrets.enabled", false);
		const unredacting = shareViaRadius(body, disabled);
		await unredacting.run();
		expect(unredacting.errors).toEqual([]);
		expect(unredacting.uploads).toHaveLength(1);
		expect(unredacting.uploads[0]).toContain(ENV_SECRET);
	});

	it("warns on an unredacted share and stays quiet on a redacted one", async () => {
		setEnv("DEPLOY_TOKEN", ENV_SECRET);
		const disabled = SettingsManager.inMemory();
		disabled.setSetting("secrets.enabled", false);
		const unredacted = shareViaRadius("nothing secret here", disabled);
		await unredacted.run();
		expect(unredacted.statuses.join("\n")).toContain("WITHOUT secret redaction");

		const redacted = shareViaRadius("nothing secret here", SettingsManager.inMemory());
		await redacted.run();
		expect(redacted.statuses.join("\n")).not.toContain("WITHOUT secret redaction");
	});

	it("masks a credential at the shortest length it will fingerprint, and leaves the one below it", async () => {
		const atBoundary = "abcd1234";
		const belowBoundary = "abc123";
		setEnv("BOUNDARY_TOKEN", atBoundary);
		setEnv("SHORT_TOKEN", belowBoundary);

		const share = shareViaRadius(`values ${atBoundary} and ${belowBoundary}`);
		await share.run();
		expect(share.errors).toEqual([]);
		expect(share.uploads[0]).toContain("abcd1234".replace(/./g, "*"));
		// One character short of the threshold, so it is a flag rather than a
		// credential, and masking it would be noise the user cannot act on.
		expect(share.uploads[0]).toContain(belowBoundary);
	});

	it("masks a credential full of characters that mean something to a regular expression", async () => {
		const awkward = "p@ss.w*rd+$^[]()";
		setEnv("ODD_TOKEN", awkward);

		const share = shareViaRadius(`connecting with ${awkward}`);
		await share.run();
		expect(share.errors).toEqual([]);
		expect(share.uploads[0]).not.toContain(awkward);
		expect(share.uploads[0]).toContain("*".repeat(awkward.length));
	});

	it("masks the shorter secret whole when one is a prefix of the other", async () => {
		setEnv("PREFIX_TOKEN", "abcdefgh");
		setEnv("LONG_TOKEN", "abcdefghijkl");

		const share = shareViaRadius("value abcdefghijkl trailing");
		await share.run();
		expect(share.errors).toEqual([]);
		expect(share.uploads[0]).not.toContain("abcdefgh");
		expect(share.uploads[0]).toContain("trailing");
	});

	it("refuses to publish a credential that was never in the environment", async () => {
		const share = shareViaRadius(`my token is ${PASTED_TOKEN}`);
		await share.run();

		expect(share.uploads).toEqual([]);
		expect(share.errors.join("\n")).toContain("Nothing was uploaded");
	});

	it("leaves ordinary content that merely looks credential-shaped intact", async () => {
		// A redactor that rewrites these is one operators learn to switch off, and
		// the damage is silent: the session is corrupted and nothing says so.
		const body = [
			"the request id was 550e8400-e29b-41d4-a716-446655440000",
			"the asset hash is d41d8cd98f00b204e9800998ecf8427e",
			"bearer authorization uses a base64ish run of characters here",
			"we rotated the token and the password and the api key today",
			"the word authentication appears in this sentence too",
		].join(" ");

		const share = shareViaRadius(body);
		await share.run();

		expect(share.errors).toEqual([]);
		expect(share.uploads).toHaveLength(1);
		expect(share.uploads[0]).toContain(body);
		expect(share.uploads[0]).not.toContain("*");
	});

	it("refuses a share whose session has no project to resolve policy against", async () => {
		setEnv("DEPLOY_TOKEN", ENV_SECRET);

		// The session owns the policy, so a session with no owning project has no
		// policy at all, and quietly borrowing the invoking directory's is the
		// mistake decideShare exists to prevent.
		const share = shareViaRadius(`deploying with ${ENV_SECRET}`, SettingsManager.inMemory(), "");
		await share.run();

		// shareViaRadius records every upload, so an empty list is the proof that
		// nothing was sent, rather than a separate flag that could drift from it.
		expect(share.uploads).toEqual([]);
		expect(share.errors.join("\n")).toContain("Share refused");
	});
});
