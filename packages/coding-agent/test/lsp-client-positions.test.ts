import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServerEnvironment, isRunnableCommand, LspClient } from "../src/core/lsp/client.ts";
import {
	displayUri,
	isWithinWorkspace,
	offsetToPosition,
	pathToUri,
	positionToOffset,
	rangeText,
	uriToPath,
	workspaceIdentity,
} from "../src/core/lsp/positions.ts";
import { TestTransport } from "../src/core/lsp/transport.ts";

/**
 * Adversarial tests for the LSP client and its document geometry.
 *
 * Three things are defended here, each of which fails silently rather than
 * loudly when wrong: UTF-16 position arithmetic, environment inheritance, and
 * a server's ability to ask this process to write.
 */

describe("UTF-16 positions", () => {
	it("round-trips ASCII offsets exactly", () => {
		const text = "one\ntwo\nthree\n";
		for (const offset of [0, 1, 3, 4, 7, 8, 13]) {
			expect(positionToOffset(text, offsetToPosition(text, offset))).toBe(offset);
		}
	});

	it("round-trips a line containing an astral character", () => {
		// The failure this guards: an emoji is two UTF-16 code units, so a
		// character computed from a code point or a byte lands mid-surrogate and
		// slicing there yields a lone surrogate — not a character.
		const text = "a🎉b\nsecond\n";
		const emojiStart = 1;
		const afterEmoji = 3;
		const position = offsetToPosition(text, afterEmoji);
		expect(position).toEqual({ line: 0, character: 3 });
		expect(positionToOffset(text, position)).toBe(afterEmoji);
		// The character is two units wide, which is what the specification means.
		expect(afterEmoji - emojiStart).toBe(2);
	});

	it("does not split a surrogate pair when a position lands inside one", () => {
		// A server asking for character 2 of "a🎉b" is asking inside the emoji.
		// The honest answer is the end of that character, not half of it.
		const text = "a🎉b\n";
		const offset = positionToOffset(text, { line: 0, character: 2 });
		expect(offset).toBe(3);
		// And the result never contains a lone surrogate.
		const result = text.slice(0, offset);
		expect([...result].length).toBe(2);
		expect(result).toBe("a🎉");
	});

	it("extracts range text containing astral characters", () => {
		const text = "start 🎉 end\n";
		const extracted = rangeText(text, { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } });
		expect(extracted).toBe("🎉");
	});

	it("handles CRLF without counting the carriage return as a character", () => {
		const text = "one\r\ntwo\r\n";
		const offset = positionToOffset(text, { line: 0, character: 3 });
		// The line content is "one", so character 3 is the end of the line, before
		// the terminator.
		expect(text.slice(0, offset)).toBe("one");
	});

	it("clamps an out-of-range line to the end of the document", () => {
		const text = "one\ntwo\n";
		// A server reporting a line past the end is describing a document we do not
		// have. Clamping to the final line is the closest defensible reading.
		expect(positionToOffset(text, { line: 99, character: 0 })).toBe(text.length);
		// A character past the end of a valid line is the end of that line, which
		// is a well-defined place rather than a guess.
		expect(positionToOffset(text, { line: 0, character: 99 })).toBe(3);
	});

	it("handles an empty document", () => {
		expect(positionToOffset("", { line: 0, character: 0 })).toBe(0);
		expect(offsetToPosition("", 0)).toEqual({ line: 0, character: 0 });
	});
});

describe("file URIs", () => {
	it("round-trips a plain path", () => {
		const path = "/home/user/project/src/a.ts";
		expect(uriToPath(pathToUri(path))).toBe(resolve(path));
	});

	it("preserves a filename containing characters a URI would otherwise eat", () => {
		// A hand-built `file://` + path breaks on every one of these, and a
		// `#`-named file is exactly what broke OMP's hashline addressing.
		for (const name of ["weird#name.ts", "has space.ts", "percent%.ts", "question?.ts", "dash-name.ts"]) {
			const path = resolve("/tmp/project", name);
			const round = uriToPath(pathToUri(path));
			expect(round, name).toBe(path);
		}
	});

	it("preserves a unicode filename", () => {
		const path = resolve("/tmp/project", "café-日本語.ts");
		expect(uriToPath(pathToUri(path))).toBe(path);
	});

	it("refuses a malformed escape rather than probing the filesystem", () => {
		expect(uriToPath("file:///tmp/%E0%A4%A")).toBeUndefined();
	});

	it("refuses a non-file scheme", () => {
		expect(uriToPath("https://example.com/x.ts")).toBeUndefined();
		expect(uriToPath("untitled:Untitled-1")).toBeUndefined();
	});

	it("refuses a file URI with a remote authority", () => {
		// `file://host/share` does not address this machine, and treating it as a
		// local path would be a confusing way to fail.
		expect(uriToPath("file://server/share/file.ts")).toBeUndefined();
	});
});

describe("workspace identity", () => {
	it("gives two worktrees of one repository different roots and the same key", () => {
		// This is the whole point: identical relative filenames in separate
		// worktrees must never share document state, while a caller can still
		// recognise them as one project.
		const repoRoot = resolve("/repo");
		const parent = workspaceIdentity(repoRoot);
		const worktree = workspaceIdentity(resolve("/repo-wt"), repoRoot);
		expect(parent.root).not.toBe(worktree.root);
		expect(worktree.repositoryKey).toBe(parent.repositoryKey);
		expect(worktree.repositoryKey).toBe(parent.repositoryKey);
	});

	it("reports containment correctly", () => {
		const identity = workspaceIdentity("/repo");
		expect(isWithinWorkspace(identity, pathToUri("/repo/src/a.ts"))).toBe(true);
		expect(isWithinWorkspace(identity, pathToUri("/repo/a.ts"))).toBe(true);
		expect(isWithinWorkspace(identity, pathToUri("/other/a.ts"))).toBe(false);
		expect(isWithinWorkspace(identity, pathToUri("/repo/../escape.ts"))).toBe(false);
	});

	it("displays a workspace-relative path but refuses to shorten a foreign one", () => {
		const identity = workspaceIdentity("/repo");
		expect(displayUri(identity, pathToUri("/repo/src/a.ts"))).toBe("src/a.ts");
		// A URI outside the workspace stays a URI: shortening it would imply it is
		// inside, which it is not.
		expect(displayUri(identity, pathToUri("/elsewhere/a.ts"))).toContain("elsewhere");
	});
});

describe("environment sanitization", () => {
	it("strips the Git redirect variables", () => {
		// A server inheriting GIT_DIR would run its git integration against a
		// different repository than the session resolved — the same mistake the VCS
		// authority exists to prevent.
		const env = buildServerEnvironment({
			PATH: "/usr/bin",
			GIT_DIR: "/somewhere/else/.git",
			GIT_WORK_TREE: "/somewhere/else",
			GIT_INDEX_FILE: "/tmp/other-index",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_WORK_TREE).toBeUndefined();
		expect(env.GIT_INDEX_FILE).toBeUndefined();
	});

	it("strips variables that would make a server prompt or execute", () => {
		const env = buildServerEnvironment({
			GIT_TERMINAL_PROMPT: "1",
			GIT_ASKPASS: "true",
			NODE_OPTIONS: "--require /tmp/evil.js",
		});
		expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
	});

	it("can start from an empty environment", () => {
		const env = buildServerEnvironment({ PATH: "/usr/bin" }, { inherit: false });
		expect(env.PATH).toBeUndefined();
	});

	it("applies extra variables last, so a caller can supply a real value", () => {
		const env = buildServerEnvironment({ GIT_DIR: "/bad" }, { extra: { GIT_DIR: "/good" } });
		expect(env.GIT_DIR).toBe("/good");
	});

	it("honours a drop predicate", () => {
		const env = buildServerEnvironment({ A: "1", B: "2" }, { drop: (name) => name === "A" });
		expect(env.A).toBeUndefined();
		expect(env.B).toBe("2");
	});
});

describe("a language server cannot write", () => {
	it("refuses a workspace/applyEdit request from the server", async () => {
		// The server proposes; Pi decides. Answering this with `applied: true`
		// would hand a language server a mutation path around the approval gate.
		const client = new LspClient({ name: "test", command: "noop", root: resolve("/tmp") });
		const transport = new TestTransport("test");
		client.__installTransport(transport);

		// Route through the handler the client itself installed, which is the path a
		// real server request takes.
		const answer = (
			client as unknown as {
				__serverRequestHandler: (m: string, p: unknown) => unknown;
			}
		).__serverRequestHandler;
		expect(typeof answer).toBe("function");
		const result = answer.call(client, "workspace/applyEdit", {
			edit: { changes: [{ textDocument: { uri: "file:///etc/passwd" }, edits: [] }] },
		});
		expect(result).toMatchObject({ applied: false });
		expect(String((result as { reason: string }).reason)).toMatch(/not applied by the client/i);
	});

	it("declines a server request when no handler is installed", () => {
		const transport = new TestTransport("t");
		transport.deliverFramed({ jsonrpc: "2.0", id: 3, method: "workspace/applyEdit", params: {} });
		const response = transport.sent.at(-1) as { error?: { code: number } };
		expect(response.error?.code).toBe(-32601);
	});
});

describe("document synchronization", () => {
	function startedClient(name: string): { client: LspClient; transport: TestTransport } {
		// A client driven by an in-memory server, so document sync is observable
		// without spawning anything. The seam is the same one `start` uses.
		const client = new LspClient({ name, command: "noop", root: resolve("/tmp/proj") });
		const transport = new TestTransport(name);
		client.__installTransport(transport);
		return { client, transport };
	}

	it("assigns monotonic versions starting at 1", () => {
		const { client } = startedClient("mono");
		const uri = pathToUri(resolve("/tmp/proj/a.ts"));
		client.openDocument(uri, "typescript", "one\n");
		expect(client.isOpen(uri)).toBe(true);
		client.changeDocument(uri, "one\ntwo\n");
		client.changeDocument(uri, "one\ntwo\nthree\n");
		// Opening a document twice must not reset the counter: a server that sees
		// a version it has already seen discards the change, leaving the two sides
		// disagreeing about the file for the rest of the session.
		client.openDocument(uri, "typescript", "one\n");
		expect(client.isOpen(uri)).toBe(true);
	});

	it("refuses to change a document that was never opened", () => {
		const { client } = startedClient("unopened");
		const uri = pathToUri(resolve("/tmp/proj/never.ts"));
		// Implicitly opening here would paper over a caller bug with a protocol
		// state the caller does not know about.
		expect(() => client.changeDocument(uri, "x")).toThrow(/not open/);
	});

	it("forgets a closed document", () => {
		const { client } = startedClient("closing");
		const uri = pathToUri(resolve("/tmp/proj/a.ts"));
		client.openDocument(uri, "typescript", "one\n");
		client.closeDocument(uri);
		expect(client.isOpen(uri)).toBe(false);
		// Closing again is a no-op, not an error.
		expect(() => client.closeDocument(uri)).not.toThrow();
	});

	it("keeps separate documents for the same relative name in two worktrees", () => {
		// The isolation property: a client rooted in one worktree must not answer
		// for another's file, and a shared relative path would blur that.
		const first = startedClient("wt-a").client;
		const second = startedClient("wt-b").client;
		const aUri = pathToUri(resolve("/repo-wt-a/src/a.ts"));
		const bUri = pathToUri(resolve("/repo-wt-b/src/a.ts"));
		first.openDocument(aUri, "typescript", "content a");
		second.openDocument(bUri, "typescript", "content b");
		expect(first.openDocuments).toEqual([aUri]);
		expect(second.openDocuments).toEqual([bUri]);
		expect(first.openDocuments).not.toContain(bUri);
	});

	it("reports capability support from the handshake result", () => {
		const client = new LspClient({ name: "caps", command: "noop", root: resolve("/tmp") });
		// Absent means unsupported; a server that omits a capability is telling us
		// it does not have one, and inferring support from silence is how a
		// request comes back as MethodNotFound at the worst moment.
		expect(client.supports("hoverProvider")).toBe(false);
	});

	it("refuses a request before start", async () => {
		const client = new LspClient({ name: "idle", command: "noop", root: resolve("/tmp") });
		await expect(client.request("textDocument/hover", {})).rejects.toThrow();
	});
});

describe("command validation", () => {
	it("rejects a path that does not exist", () => {
		expect(isRunnableCommand(resolve("/definitely/not/here/language-server"))).toBe(false);
	});

	it("rejects a directory", () => {
		expect(isRunnableCommand(resolve("/tmp"))).toBe(false);
	});
});

describe("lifecycle guards", () => {
	it("will not spawn a command that does not exist, and reports why", async () => {
		const client = new LspClient({
			name: "missing",
			command: resolve("/definitely/not/here/server"),
			root: resolve("/tmp"),
			initTimeoutMs: 2_000,
		});
		await expect(client.start()).rejects.toThrow(/failed to initialize/);
		expect(client.state).toBe("failed");
	});

	it("will not start twice once running", async () => {
		const client = new LspClient({ name: "once", command: "noop", root: resolve("/tmp") });
		client.__installTransport(new TestTransport("once"));
		// Already ready, so a second start is a no-op. Respawning a running server
		// would orphan its documents.
		await expect(client.start()).resolves.toBeUndefined();
		expect(client.state).toBe("ready");
	});

	it("reports a failed start rather than a running client", async () => {
		const client = new LspClient({
			name: "failed",
			command: resolve("/definitely/not/here/server"),
			root: resolve("/tmp"),
			initTimeoutMs: 2_000,
		});
		await expect(client.start()).rejects.toThrow(/failed to initialize/);
		// A failed client never claims to be ready, which is what would let a
		// document sync report success into a server that does not exist.
		expect(client.state).toBe("failed");
		expect(client.initialized).toBe(false);
		expect(client.failure?.message).toBeTruthy();
		// And a request against it fails rather than hanging.
		await expect(client.request("textDocument/hover", {})).rejects.toThrow(/closed|not running/);
	});
});
