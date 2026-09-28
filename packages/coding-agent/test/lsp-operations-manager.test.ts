import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/core/lsp/client.ts";
import {
	clientKey,
	LspManager,
	type LspServerConfig,
	resolveExecutable,
	resolveServers,
	serverForFile,
} from "../src/core/lsp/manager.ts";
import {
	declaration,
	definition,
	describeSeverity,
	describeSymbolKind,
	diagnosticsFor,
	documentSymbols,
	hover,
	normalizeLocations,
	references,
	typeDefinition,
	workspaceSymbols,
} from "../src/core/lsp/operations.ts";
import { pathToUri } from "../src/core/lsp/positions.ts";
import { TestTransport } from "../src/core/lsp/transport.ts";

/**
 * Adversarial tests for the LSP operations and server manager.
 *
 * Two properties are defended. First, a result shape the protocol permits must
 * be understood — a wrapper that accepts only one form reports "nothing found"
 * against a server that answered, which is a wrong answer shaped like a right
 * one. Second, a repository must not be able to choose what program runs.
 */

const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROOT = () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-lsp-"));
	roots.push(dir);
	return dir;
};

/** A client wired to an in-memory server, with capabilities preset. */
function client(
	root: string,
	capabilities: Record<string, unknown>,
	responder: (method: string, params: unknown) => unknown,
) {
	const transport = new TestTransport("t", {
		onServerRequest: () => ({ applied: false }),
	});
	const instance = new LspClient({ name: "t", command: "noop", root });
	instance.__installTransport(transport);
	// Preload the handshake result, so `supports` reflects the server.
	instance.__setCapabilities(capabilities);
	transport.responder = responder;
	return { client: instance, transport };
}

const CAPS = {
	definitionProvider: true,
	declarationProvider: true,
	typeDefinitionProvider: true,
	referencesProvider: true,
	hoverProvider: true,
	documentSymbolProvider: true,
	workspaceSymbolProvider: true,
	signatureHelpProvider: { triggerCharacters: ["("] },
};

describe("location result shapes", () => {
	it("accepts every form the protocol permits", () => {
		// A server picks the form per its advertised capabilities and sometimes
		// per request, so a wrapper that accepts one form reports "not found"
		// against a server that answered.
		const single = {
			uri: "file:///a.ts",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		};
		expect(normalizeLocations(single)).toMatchObject({ form: "location" });
		expect(normalizeLocations([single])).toMatchObject({ form: "locations" });
		const link = { targetUri: "file:///b.ts", targetRange: single.range };
		expect(normalizeLocations(link)).toMatchObject({ form: "link" });
		expect(normalizeLocations([link])).toMatchObject({ form: "links" });
		expect(normalizeLocations(null)).toMatchObject({ form: "none" });
		expect(normalizeLocations([])).toMatchObject({ form: "none" });
	});

	it("prefers a link's selection range", () => {
		const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
		const selection = { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } };
		const { locations } = normalizeLocations({
			targetUri: "file:///b.ts",
			targetRange: range,
			targetSelectionRange: selection,
		});
		expect(locations[0]?.range).toEqual(selection);
	});

	it("ignores a result that is neither shape", () => {
		expect(normalizeLocations({ nonsense: true })).toMatchObject({ form: "none" });
		expect(normalizeLocations("a string")).toMatchObject({ form: "none" });
	});
});

describe("operations handle every result shape the protocol permits", () => {
	it("reads a LocationLink[] definition result, which a single-form wrapper would miss", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const target = join(root, "b.ts");
		writeFileSync(target, "const a = 1;\n", "utf8");

		const { client: instance, transport } = client(root, CAPS, () => [
			{
				targetUri: pathToUri(target),
				targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
				targetSelectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
			},
		]);
		const pending = definition(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/definition", {});

		const result = await pending;
		expect(result.form).toBe("links");
		// The selection range wins, so a reviewer is taken to the identifier rather
		// than the whole declaration.
		expect(result.locations[0]?.range.start.character).toBe(6);
		expect(result.locations[0]?.displayPath).toBe("b.ts");
		// Positions are reported 1-based for a human alongside the protocol value.
		expect(result.locations[0]?.line).toBe(1);
		expect(result.locations[0]?.outsideWorkspace).toBe(false);
	});

	it("reads a null definition result as an honest empty answer", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const { client: instance, transport } = client(root, CAPS, () => null);
		const pending = definition(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/definition", {});
		const result = await pending;
		expect(result.form).toBe("none");
		expect(result.locations).toEqual([]);
	});

	it("marks a reference outside the workspace rather than shortening it", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const { client: instance, transport } = client(root, CAPS, () => [
			{
				uri: "file:///elsewhere/other.ts",
				range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } },
			},
		]);
		const pending = references(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/references", {});
		const result = await pending;
		expect(result).toHaveLength(1);
		// A path outside the workspace stays flagged. Presenting it as a relative
		// path would imply it is inside, which it is not.
		expect(result[0]?.outsideWorkspace).toBe(true);
	});

	it("renders hover contents from every permitted form", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		// MarkedString[] is a permitted form; a wrapper reading only `contents.value`
		// would render nothing.
		const { client: instance, transport } = client(root, CAPS, () => ({
			contents: [
				{ language: "typescript", value: "const a: number" },
				{ language: "ts", value: "1" },
			],
		}));
		const pending = hover(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/hover", {});
		const result = await pending;
		expect(result?.contents).toContain("const a: number");
		expect(result?.contents).toContain("1");
	});

	it("handles the flat SymbolInformation document-symbol form as well as the hierarchical one", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const { client: instance, transport } = client(root, CAPS, () => [
			// Flat form: a location rather than a range.
			{
				name: "a",
				kind: 13,
				location: {
					uri: pathToUri(file),
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
				},
			},
		]);
		const pending = documentSymbols(instance, { uri: pathToUri(file) });
		await transport.answerNext("textDocument/documentSymbol", {});
		const result = await pending;
		expect(result[0]?.name).toBe("a");
		expect(result[0]?.kind).toBe("variable");
		expect(result[0]?.line).toBe(1);
	});

	it("resolves published diagnostics with severity and 1-based position", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const uri = pathToUri(file);
		const { client: instance } = client(root, CAPS, () => null);
		const published = new Map([
			[
				uri,
				[
					{
						range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
						severity: 1,
						message: "unused",
						source: "ts",
					},
				],
			],
		]);
		const resolved = diagnosticsFor(instance, published, uri);
		expect(resolved[0]?.severity).toBe("error");
		expect(resolved[0]?.line).toBe(1);
		expect(resolved[0]?.column).toBe(7);
		expect(resolved[0]?.displayPath).toBe("a.ts");
	});
});

describe("capability gating", () => {
	it("refuses an operation the server did not advertise", async () => {
		const root = ROOT();
		const { client: instance } = client(root, {}, () => null);
		// Inferring support from silence is how a request comes back as
		// MethodNotFound at the worst moment.
		await expect(
			definition(instance, { uri: pathToUri(join(root, "a.ts")), position: { line: 0, character: 0 } }),
		).rejects.toThrow(/does not support/);
	});
});

describe("server discovery never installs and never trusts a project by default", () => {
	const CONFIGURED: LspServerConfig = { name: "ts", command: "definitely-not-installed-server", extensions: [".ts"] };

	it("reports a missing executable rather than installing it", () => {
		const resolved = resolveServers([CONFIGURED], { projectTrusted: true, env: { PATH: "/nonexistent" } });
		expect(resolved[0]?.available).toBe(false);
		// The reason names installation as the user's action, because nothing here
		// downloads or modifies PATH.
		expect(resolved[0]?.reason).toMatch(/not found on PATH/);
	});

	it("refuses a project-provided server when the project is untrusted", () => {
		// A cloned repository must not be able to cause an arbitrary program to
		// run. This is the boundary.
		const fromProject: LspServerConfig = { ...CONFIGURED, command: process.execPath, fromProject: true };
		const untrusted = resolveServers([fromProject], { projectTrusted: false, env: { PATH: "" } });
		expect(untrusted[0]?.available).toBe(false);
		expect(untrusted[0]?.reason).toMatch(/not trusted/);

		// The same server is allowed once the project is trusted, provided the
		// executable exists.
		const trusted = resolveServers([fromProject], { projectTrusted: true, env: { PATH: "" } });
		expect(trusted[0]?.available).toBe(true);
	});

	it("does not look up a path-like command on PATH", () => {
		// Searching PATH for something containing a separator is how a relative or
		// absolute path gets silently reinterpreted.
		const result = resolveExecutable("./some/relative/server", { PATH: process.env.PATH ?? "" });
		expect(result).toBeUndefined();
	});

	it("finds a real executable on PATH", () => {
		// The one thing this does: locate something already installed.
		const result = resolveExecutable(process.platform === "win32" ? "cmd" : "sh");
		expect(result).toBeDefined();
	});
});

describe("server selection and client keys", () => {
	const SERVERS: LspServerConfig[] = [
		{ name: "ts", command: "tsserver", extensions: [".ts", ".tsx"] },
		{ name: "py", command: "pyright", extensions: [".py"] },
	];

	it("selects by extension, case-insensitively", () => {
		const resolved = resolveServers(SERVERS, { projectTrusted: true, env: { PATH: "" } });
		expect(serverForFile(resolved, "src/a.TS")?.config.name).toBe("ts");
		expect(serverForFile(resolved, "src/a.py")?.config.name).toBe("py");
		expect(serverForFile(resolved, "README.md")).toBeUndefined();
		expect(serverForFile(resolved, "Makefile")).toBeUndefined();
	});

	it("keys a client by command, root and settings", () => {
		// The root is in the key, which is what keeps a delegated worktree from
		// inheriting the parent's client. Settings are in it so two servers with
		// different configuration are not conflated.
		const a = clientKey("tsserver", "/repo", undefined);
		const b = clientKey("tsserver", "/repo-wt", undefined);
		const c = clientKey("tsserver", "/repo", { a: 1 });
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});

	it("produces one key for structurally equal settings", () => {
		// Two equal objects must not double the process count.
		expect(clientKey("c", "/r", { a: 1, b: 2 })).toBe(clientKey("c", "/r", { b: 2, a: 1 }));
	});
});

describe("worktree isolation", () => {
	it("gives two managers for two worktrees entirely separate clients", () => {
		// The structural property: nothing is shared across roots, so one
		// worktree's documents can never answer another's questions.
		const parentRoot = ROOT();
		const childRoot = ROOT();
		const config: LspServerConfig[] = [{ name: "ts", command: "tsserver", extensions: [".ts"] }];
		const parent = new LspManager({ root: parentRoot, servers: config, projectTrusted: true, env: { PATH: "" } });
		const child = new LspManager({ root: childRoot, servers: config, projectTrusted: true, env: { PATH: "" } });
		expect(parent.root).not.toBe(child.root);
		// Same command and settings, different root: the keys differ, so a client
		// started for one is never handed to the other.
		expect(clientKey("tsserver", parentRoot, undefined)).not.toBe(clientKey("tsserver", childRoot, undefined));
	});

	it("reports a status entry per configured server, including unavailable ones", () => {
		const manager = new LspManager({
			root: ROOT(),
			servers: [{ name: "ts", command: "not-installed", extensions: [".ts"] }],
			projectTrusted: true,
			env: { PATH: "" },
		});
		const status = manager.status();
		expect(status).toHaveLength(1);
		expect(status[0]?.available).toBe(false);
		expect(status[0]?.running).toBe(false);
		expect(status[0]?.reason).toBeTruthy();
	});
});

describe("presentation helpers", () => {
	it("describes severity, including the unknown case", () => {
		expect(describeSeverity(1)).toBe("error");
		expect(describeSeverity(2)).toBe("warning");
		expect(describeSeverity(3)).toBe("information");
		expect(describeSeverity(4)).toBe("hint");
		// An unrecognised severity is reported as unknown rather than guessed:
		// a diagnostic presented as an error when it is a warning is a real
		// misdirection.
		expect(describeSeverity(99)).toBe("unknown");
		expect(describeSeverity(undefined)).toBe("unknown");
	});

	it("describes symbol kinds, including ones it does not know", () => {
		expect(describeSymbolKind(5)).toBe("class");
		expect(describeSymbolKind(12)).toBe("function");
		expect(describeSymbolKind(9999)).toBe("kind-9999");
		expect(describeSymbolKind("custom")).toBe("custom");
	});
});

describe("capability-specific operations", () => {
	it("reads a declaration result, which a different capability names", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const target = join(root, "types.ts");
		writeFileSync(target, "type A = number;\n", "utf8");
		// `declaration` and `typeDefinition` are separate capabilities; a wrapper
		// treating them as one would call a method the server may not have.
		const { client: instance, transport } = client(root, CAPS, () => ({
			uri: pathToUri(target),
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
		}));
		const pending = declaration(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/declaration", {});
		const result = await pending;
		expect(result.form).toBe("location");
		expect(result.locations[0]?.displayPath).toBe("types.ts");
	});

	it("reads a type-definition result", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "const a = 1;\n", "utf8");
		const { client: instance, transport } = client(root, CAPS, () => []);
		const pending = typeDefinition(instance, { uri: pathToUri(file), position: { line: 0, character: 6 } });
		await transport.answerNext("textDocument/typeDefinition", {});
		// An empty array is an honest "no type definition", distinct from a shape
		// the wrapper failed to understand.
		expect((await pending).form).toBe("none");
	});

	it("reads workspace symbols and reports their kind", async () => {
		const root = ROOT();
		const file = join(root, "a.ts");
		writeFileSync(file, "export function helper() {}\n", "utf8");
		const { client: instance, transport } = client(root, CAPS, () => [
			{
				name: "helper",
				kind: 12,
				location: {
					uri: pathToUri(file),
					range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
				},
			},
		]);
		const pending = workspaceSymbols(instance, { query: "help" });
		await transport.answerNext("workspace/symbol", {});
		const result = await pending;
		expect(result[0]?.name).toBe("helper");
		expect(result[0]?.kind).toBe("function");
		expect(result[0]?.displayPath).toBe("a.ts");
	});
});
