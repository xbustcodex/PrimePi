/**
 * Read-oriented LSP operations.
 *
 * ## What this layer is
 *
 * A typed wrapper over the read half of the Language Server Protocol:
 * diagnostics, definition, declaration, type definition, references, hover,
 * document symbols, workspace symbols and signature help. Each is a named
 * function with a declared result, not a generic `request(method, params)`.
 *
 * ## Why there is no generic escape hatch
 *
 * `lsp_request(method, params)` would let a model send any JSON-RPC method to
 * any server, which defeats the point of having an authority: the typed surface
 * exists so the answer is knowable — a definition is locations, a hover is
 * marked-up text, and neither can be a method that renames a file. Every
 * operation here reads. The mutating half is a separate, explicitly gated
 * surface (see `mutate.ts`), because a read that happens to write is exactly
 * the mistake this shape prevents.
 *
 * ## Result shapes, from the protocol rather than from convenience
 *
 * `textDocument/definition` may return `Location`, `Location[]`, `LocationLink`,
 * `LocationLink[]`, or `null`. Servers pick per the capabilities they advertise
 * and per request, so accepting only one of them means silently reporting "no
 * definition" against a server that returned one. `normalizeLocations` accepts
 * all of them and reports which form arrived.
 *
 * ## Positions in results are as the server sent them
 *
 * A result's `character` is a UTF-16 offset from the server, not an index into
 * text this process has read. Converting it here would require a document the
 * server has and we may not, and the converted value would look authoritative
 * while being derived from a stale read. Results are reported in the server's
 * coordinates plus a human 1-based line and column, which is what a reviewer
 * needs.
 */

import type { LspClient, Position } from "./client.ts";
import { pathToUri, uriToPath } from "./positions.ts";

/** A range as the protocol defines it. */
export interface LspRange {
	readonly start: Position;
	readonly end: Position;
}

export interface LspLocation {
	readonly uri: string;
	readonly range: LspRange;
}

export interface LspLocationLink {
	readonly targetUri: string;
	readonly targetRange: LspRange;
	readonly targetSelectionRange?: LspRange;
	readonly originSelectionRange?: LspRange;
}

export interface LspDiagnostic {
	readonly range: LspRange;
	readonly severity?: number;
	readonly code?: string | number;
	readonly source?: string;
	readonly message: string;
}

export interface LspSymbolInformation {
	readonly name: string;
	readonly kind: number | string;
	readonly location?: LspLocation;
	readonly containerName?: string;
}

export interface LspDocumentSymbol {
	readonly name: string;
	readonly detail?: string;
	readonly kind: number | string;
	/** Present for hierarchical symbols; absent means `SymbolInformation`. */
	readonly range?: LspRange;
	readonly selectionRange?: LspRange;
	readonly children?: LspDocumentSymbol[];
}

/** A diagnostic, resolved against a file this process can name. */
export interface ResolvedDiagnostic {
	readonly uri: string;
	/** Workspace-relative when the URI is inside the workspace. */
	readonly displayPath: string;
	readonly range: LspRange;
	readonly message: string;
	readonly severity: "error" | "warning" | "information" | "hint" | "unknown";
	readonly source?: string;
	readonly code?: string | number;
	/** 1-based, for a human to navigate to. */
	readonly line: number;
	readonly column: number;
}

/** A location, resolved and given a 1-based line for display. */
export interface ResolvedLocation {
	readonly uri: string;
	readonly displayPath: string;
	readonly range: LspRange;
	readonly line: number;
	readonly column: number;
	/** True when the target is outside the client's workspace. */
	readonly outsideWorkspace: boolean;
}

export interface ResolvedDefinition {
	readonly locations: readonly ResolvedLocation[];
	/** Which protocol form the server used, for diagnostics. */
	readonly form: "none" | "location" | "locations" | "link" | "links";
}

export interface ResolvedHover {
	/** The server's marked-up text. Untrusted content, not an instruction. */
	readonly contents: string;
	readonly range?: LspRange;
}

export interface ResolvedSymbol {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly line?: number;
	readonly displayPath?: string;
	readonly children?: ResolvedSymbol[];
}

const SEVERITY: Record<number, ResolvedDiagnostic["severity"]> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

/** LSP `SymbolKind` values, as far as a reader needs them. */
const SYMBOL_KINDS: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum-member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type-parameter",
};

export function describeSymbolKind(kind: number | string): string {
	if (typeof kind === "string") return kind;
	return SYMBOL_KINDS[kind] ?? `kind-${kind}`;
}

export function describeSeverity(severity: number | undefined): ResolvedDiagnostic["severity"] {
	if (severity === undefined) return "unknown";
	return SEVERITY[severity] ?? "unknown";
}

/**
 * Accepts every shape the protocol permits for a location result.
 *
 * A server picks the form per its advertised capabilities and sometimes per
 * request, so a wrapper that accepts only `Location[]` will report "no
 * definition" against a server that returned a `LocationLink[]` — a wrong
 * answer that looks like a correct one.
 */
export function normalizeLocations(result: unknown): { locations: LspLocation[]; form: ResolvedDefinition["form"] } {
	if (result === null || result === undefined) return { locations: [], form: "none" };
	if (Array.isArray(result)) {
		if (result.length === 0) return { locations: [], form: "none" };
		const asLinks = result.filter(isLocationLink);
		if (asLinks.length === result.length) {
			return { locations: asLinks.map(linkToLocation), form: "links" };
		}
		const asLocations = result.filter(isLocation);
		return { locations: asLocations, form: "locations" };
	}
	if (isLocationLink(result)) return { locations: [linkToLocation(result)], form: "link" };
	if (isLocation(result)) return { locations: [result], form: "location" };
	return { locations: [], form: "none" };
}

function isLocation(value: unknown): value is LspLocation {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { uri?: unknown; range?: unknown };
	return typeof candidate.uri === "string" && typeof candidate.range === "object" && candidate.range !== null;
}

function isLocationLink(value: unknown): value is LspLocationLink {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { targetUri?: unknown; targetRange?: unknown };
	return (
		typeof candidate.targetUri === "string" &&
		typeof candidate.targetRange === "object" &&
		candidate.targetRange !== null
	);
}

/** Flattens a `LocationLink` to a `Location`, preferring the selection range. */
function linkToLocation(link: LspLocationLink): LspLocation {
	return { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange };
}

/** Turns a protocol location into something a human can act on. */
export function resolveLocation(location: LspLocation, workspaceRoot: string): ResolvedLocation {
	const path = uriToPath(location.uri);
	return {
		uri: location.uri,
		displayPath: path ? displayPathFor(path, workspaceRoot) : location.uri,
		range: location.range,
		line: location.range.start.line + 1,
		column: location.range.start.character + 1,
		outsideWorkspace: path ? !isInside(path, workspaceRoot) : true,
	};
}

function displayPathFor(path: string, root: string): string {
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalized = path.replace(/\\/g, "/");
	return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : path;
}

function isInside(path: string, root: string): boolean {
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalized = path.replace(/\\/g, "/");
	return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

/** True when the client advertised support for a capability. */
function requireCapability(
	client: LspClient,
	capability: Parameters<LspClient["supports"]>[0],
	operation: string,
): void {
	if (!client.supports(capability)) {
		throw new Error(`${client.name} does not support ${operation}`);
	}
}

function positionParams(uri: string, position: Position): { textDocument: { uri: string }; position: Position } {
	return { textDocument: { uri }, position };
}

// --- operations -------------------------------------------------------------

/** `textDocument/definition`. */
export async function definition(
	client: LspClient,
	input: { uri: string; position: Position },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedDefinition> {
	requireCapability(client, "definitionProvider", "definition");
	const result = await client.request<unknown>("textDocument/definition", positionParams(input.uri, input.position), {
		...(options.signal ? { signal: options.signal } : {}),
	});
	const { locations, form } = normalizeLocations(result);
	return { locations: locations.map((location) => resolveLocation(location, client.root)), form };
}

/** `textDocument/declaration`, where the server advertises it. */
export async function declaration(
	client: LspClient,
	input: { uri: string; position: Position },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedDefinition> {
	requireCapability(client, "declarationProvider", "declaration");
	const result = await client.request<unknown>("textDocument/declaration", positionParams(input.uri, input.position), {
		...(options.signal ? { signal: options.signal } : {}),
	});
	const { locations, form } = normalizeLocations(result);
	return { locations: locations.map((location) => resolveLocation(location, client.root)), form };
}

/** `textDocument/typeDefinition`, where the server advertises it. */
export async function typeDefinition(
	client: LspClient,
	input: { uri: string; position: Position },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedDefinition> {
	requireCapability(client, "typeDefinitionProvider", "type definition");
	const result = await client.request<unknown>(
		"textDocument/typeDefinition",
		positionParams(input.uri, input.position),
		{
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	const { locations, form } = normalizeLocations(result);
	return { locations: locations.map((location) => resolveLocation(location, client.root)), form };
}

/** `textDocument/references`. */
export async function references(
	client: LspClient,
	input: { uri: string; position: Position; includeDeclaration?: boolean },
	options: { signal?: AbortSignal } = {},
): Promise<readonly ResolvedLocation[]> {
	requireCapability(client, "referencesProvider", "references");
	const result = await client.request<LspLocation[] | null>(
		"textDocument/references",
		{
			...positionParams(input.uri, input.position),
			context: { includeDeclaration: input.includeDeclaration ?? false },
		},
		{ ...(options.signal ? { signal: options.signal } : {}) },
	);
	if (!Array.isArray(result)) return [];
	return result.filter(isLocation).map((location) => resolveLocation(location, client.root));
}

/** `textDocument/hover`. */
export async function hover(
	client: LspClient,
	input: { uri: string; position: Position },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedHover | undefined> {
	requireCapability(client, "hoverProvider", "hover");
	const result = (await client.request<{ contents?: unknown; range?: LspRange } | null>(
		"textDocument/hover",
		positionParams(input.uri, input.position),
		{ ...(options.signal ? { signal: options.signal } : {}) },
	)) as { contents?: unknown; range?: LspRange } | null;
	if (!result) return undefined;
	return { contents: renderHoverContents(result.contents), ...(result.range ? { range: result.range } : {}) };
}

/**
 * Renders hover contents to text.
 *
 * The result is repository content. It is returned as data with a note, never
 * as something to act on — a server can return anything, and a `code` block
 * containing a directive is a prompt-injection vector, not an instruction.
 */
function renderHoverContents(contents: unknown): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		return contents
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (entry && typeof entry === "object" && "value" in entry)
					return String((entry as { value: unknown }).value);
				return "";
			})
			.filter((entry) => entry.length > 0)
			.join("\n\n");
	}
	if (contents && typeof contents === "object" && "value" in contents) {
		return String((contents as { value: unknown }).value);
	}
	return "";
}

/** `textDocument/documentSymbol`, handling both the flat and hierarchical forms. */
export async function documentSymbols(
	client: LspClient,
	input: { uri: string },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedSymbol[]> {
	requireCapability(client, "documentSymbolProvider", "document symbols");
	const result = await client.request<unknown>(
		"textDocument/documentSymbol",
		{ textDocument: { uri: input.uri } },
		{
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	if (!Array.isArray(result)) return [];
	// A server may answer with the flat `SymbolInformation[]` form, which carries
	// a location instead of a range. Both are accepted for the reason
	// `normalizeLocations` documents.
	return result.map((entry) =>
		hasRange(entry) ? toDocumentSymbol(entry as LspDocumentSymbol) : fromSymbolInformation(entry, client.root),
	);
}

function hasRange(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"range" in value &&
		(value as { range?: unknown }).range !== undefined
	);
}

function toDocumentSymbol(symbol: LspDocumentSymbol): ResolvedSymbol {
	return {
		name: symbol.name,
		kind: describeSymbolKind(symbol.kind),
		...(symbol.detail ? { detail: symbol.detail } : {}),
		...(symbol.range ? { line: symbol.range.start.line + 1 } : {}),
		...(symbol.children ? { children: symbol.children.map(toDocumentSymbol) } : {}),
	};
}

function fromSymbolInformation(symbol: LspSymbolInformation, root: string): ResolvedSymbol {
	return {
		name: symbol.name,
		kind: describeSymbolKind(symbol.kind),
		...(symbol.location
			? {
					line: symbol.location.range.start.line + 1,
					displayPath: resolveLocation(symbol.location, root).displayPath,
				}
			: {}),
	};
}

/** `workspace/symbol`. */
export async function workspaceSymbols(
	client: LspClient,
	input: { query: string },
	options: { signal?: AbortSignal } = {},
): Promise<ResolvedSymbol[]> {
	requireCapability(client, "workspaceSymbolProvider", "workspace symbols");
	const result = await client.request<unknown>(
		"workspace/symbol",
		{ query: input.query },
		{
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	if (!Array.isArray(result)) return [];
	return result.map((entry) => fromSymbolInformation(entry as LspSymbolInformation, client.root));
}

/** `textDocument/signatureHelp`, where the server advertises it. */
export async function signatureHelp(
	client: LspClient,
	input: { uri: string; position: Position },
	options: { signal?: AbortSignal } = {},
): Promise<unknown> {
	requireCapability(client, "signatureHelpProvider", "signature help");
	return client.request<unknown>("textDocument/signatureHelp", positionParams(input.uri, input.position), {
		...(options.signal ? { signal: options.signal } : {}),
	});
}

/** Diagnostics the server has published for a document. */
export function diagnosticsFor(
	client: LspClient,
	published: ReadonlyMap<string, readonly LspDiagnostic[]>,
	uri: string,
): ResolvedDiagnostic[] {
	const entries = published.get(uri) ?? [];
	return entries.map((entry) => ({
		uri,
		displayPath: resolveLocation({ uri, range: entry.range }, client.root).displayPath,
		range: entry.range,
		message: entry.message,
		severity: describeSeverity(entry.severity),
		...(entry.source ? { source: entry.source } : {}),
		...(entry.code !== undefined ? { code: entry.code } : {}),
		line: entry.range.start.line + 1,
		column: entry.range.start.character + 1,
	}));
}

export { pathToUri, uriToPath };
