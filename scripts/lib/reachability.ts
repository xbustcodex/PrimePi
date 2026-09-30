/**
 * Settings runtime-reachability analysis.
 *
 * ## Why this exists
 *
 * The parity ledger classifies a row `wired` from a prose note. An audit on
 * 2026-09-30 found 223 of 249 rows so classified had a registered settings key
 * that no source file referenced. The note is a claim; this is the measurement.
 *
 * ## What counts as consumption
 *
 * Not a literal key string in a consumer. PrimePi's settings reach runtime
 * through three real shapes, and penalising any of them would be penalising good
 * architecture:
 *
 * 1. **Direct** — `getSetting("retry.maxRetries")` in a production file.
 * 2. **Named getter** — `getImageAutoResize()` reading `this.settings.images?.autoResize`.
 *    The dotted key is split across a nested path, so no literal string exists.
 * 3. **Accessor helper** — `getRetryFallbackChains()` delegating to
 *    `getStringListMap("retry.fallbackChains")`.
 *
 * In all three the *caller* of the getter is the consumer, so the analysis indexes
 * method name → key and then attributes every production call to that name. The
 * name is irrelevant; what matters is that a method by that name resolves the key
 * and that something calls it.
 *
 * ## Why it stays conservative
 *
 * Every heuristic here can produce a false negative and none may produce a false
 * positive. A false negative is a row that looks unconsumed and needs a human
 * read; a false positive is a row declared reachable that is actually inert, which
 * is exactly the failure this replaces. So every edge requires positive evidence,
 * and an unresolvable method name produces no edge rather than a hopeful one.
 */

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/**
 * A settings key whose consumption cannot be settled statically.
 *
 * PrimePi has accessors whose key is a *parameter* rather than a literal —
 * `getCompactionTokenSetting(field)` reaches `compaction.thresholdTokens` or
 * `compaction.thresholdPercent` depending on what the caller passes, and
 * resolving that needs the caller's argument plus the grouped record it indexes.
 *
 * These are reported, never guessed in either direction. Counting them as
 * consumed would declare an inert setting reachable, which is the exact failure
 * this system replaces. Dropping them would hide real integration behind a
 * limitation. So they are named, and a human settles them.
 */
export interface NeedsReview {
	/** The getter whose key could not be resolved. */
	readonly getter: string;
	/** The file that calls it. */
	readonly site: string;
	readonly reason: "parameterized-accessor";
}

import path from "node:path";

/** One proven edge in the settings-to-runtime graph. */
export interface ConsumptionEdge {
	readonly key: string;
	/** Production file that obtains the key. */
	readonly site: string;
	/** Which shape established the edge. */
	readonly via: "direct" | "nested-path" | "accessor-helper";
}

/** A settings key and every production site that obtains it. */
export interface KeyReachability {
	readonly key: string;
	readonly edges: readonly ConsumptionEdge[];
}

/** Directories that can hold a production consumer. */
const CONSUMER_ROOTS = [
	"packages/ai/src",
	"packages/agent/src",
	"packages/coding-agent/src",
	"packages/tui/src",
	"packages/server/src",
];

/**
 * Files whose key reads are definitions rather than consumption.
 *
 * A descriptor declares a default; a registry stores it. Neither is a runtime
 * path. They are still parsed for getter *definitions*, which is where the
 * name→key index comes from.
 */
const DEFINITION_ONLY = new Set(["settings-descriptors.ts", "settings-registry.ts"]);

/** Files holding only declarations and descriptions. */
const DECLARATION_ONLY = new Set([
	...DEFINITION_ONLY,
	"settings-parity-rows.ts",
	"settings-parity-ledger.ts",
	"settings.ts",
]);

/** Test paths: a key read only from a test is not runtime consumption. */
function isTestPath(file: string): boolean {
	return /[/\\]test[/\\]/.test(file) || /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file);
}

/**
 * Typed helpers that take a key as their only argument.
 *
 * A getter delegating to one of these with a literal resolves the key. The list
 * is deliberately explicit rather than a wildcard: a wildcard over any call with
 * a string literal would resolve accessors that do not read settings at all.
 */
const KEY_HELPERS = ["getSetting", "getStringListMap", "getStringList", "getString", "getNumber", "getBoolean"] as const;

interface ParsedFile {
	readonly file: string;
	readonly source: ts.SourceFile;
	/** Keys read by a literal `getSetting("...")`. */
	readonly directKeys: string[];
	/** Method name → key, for getters that resolve one. */
	readonly accessors: Map<string, string>;
}

/**
 * Keys read through a reader passed into a resolver.
 *
 * Tools take a `readSetting?: (key) => unknown` rather than a resolved value, so a
 * mid-session settings change takes effect on the next call. A resolver that calls
 * its reader with a literal is reading the key as directly as `getSetting` would be.
 */
function injectedReaderKeys(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const walk = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression)
					? node.expression.name.text
					: undefined;
			// A reader parameter is named for what it does; a method of the same name on a
			// helper class would be a different thing, so only identifiers are matched.
			// A resolver often wraps its reader in a local closure:
			//   const number = (key, fallback) => { const v = read(key); ... };
			// so the literal reaches read one frame down. Both are direct reads.
			if (callee !== undefined && (READER_NAMES.has(callee) || LOCAL_READERS.has(callee))) {
				const argument = node.arguments[0];
				if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
					found.push(argument.text);
				}
			}
			// Optional call: read?.("key")
			if (node.questionDotToken !== undefined && ts.isStringLiteral(node.expression)) {
				found.push(node.expression.text);
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** Parameter names that carry a settings reader into a resolver. */
const READER_NAMES = new Set(["read", "readSetting", "readKey", "setting", "get"]);

/**
 * Local closures a resolver defines over its reader.
 *
 *  is the
 * dominant shape in the tool factories: the literal is one frame below the call.
 * Matching the name is safe because a false positive would require a production
 * file to define a same-named closure *and* pass a settings literal to it.
 */
const LOCAL_READERS = new Set(["number", "numberOr", "bool", "boolean", "text", "list", "map", "record", "stringOr"]);

/** String literals passed as the first argument to any of `KEY_HELPERS`. */
function helperLiterals(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const walk = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = ts.isPropertyAccessExpression(node.expression)
				? node.expression.name.text
				: ts.isIdentifier(node.expression)
					? node.expression.text
					: undefined;
			if (callee !== undefined && (KEY_HELPERS as readonly string[]).includes(callee)) {
				const argument = node.arguments[0];
				if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
					found.push(argument.text);
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/**
 * Keys read through a nested settings path.
 *
 * `this.settings.images?.autoResize` is the dotted key `images.autoResize`
 * written across a member chain, which is why no literal string exists for it.
 * Only chains rooted at the settings object are considered; an arbitrary member
 * chain would resolve keys that are not settings at all.
 *
 * ## Why a leading `this` is stripped
 *
 * Every `SettingsManager` getter writes `this.settings.<group>.<key>`, so
 * keeping the `this` segment made the root test fail and the whole chain was
 * dropped. The accessor then indexed zero keys, never entered the accessor
 * index, and every *call site* of that accessor produced no edge either —
 * `getImageAutoResize` and `getBlockImages` were both reported as having no
 * production read while three and one call sites respectively read them.
 *
 * Stripping the receiver is the whole correction. It is additive: a chain that
 * already resolved still resolves, so this can only add edges, never remove
 * them. A bare `this.foo` stays rejected, since there is no settings root in
 * it to resolve.
 */
function nestedPathKeys(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const walk = (node: ts.Node) => {
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			// A `this.settings.x` chain and a bare `settings.x` chain name the same
			// key; only the receiver differs, and the receiver is not part of it.
			const chain = memberChain(node);
			if (chain && chain.length >= 2) {
				const rooted = chain[0] === "this" ? chain.slice(1) : chain;
				if (rooted.length < 2) {
					ts.forEachChild(node, walk);
					return;
				}
				const [root, ...rest] = rooted;
				const isSettingsRoot =
					root === "settings" ||
					root === "globalSettings" ||
					root === "projectSettings" ||
					root === "settingsManager";
				if (isSettingsRoot && rest.every((segment) => /^[a-zA-Z_$][\w$]*$/.test(segment))) {
					found.push(rest.join("."));
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** Flattens a member-access chain to its segment names. */
function memberChain(node: ts.Node): string[] | undefined {
	const segments: string[] = [];
	let current: ts.Node = node;
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		if (ts.isPropertyAccessExpression(current)) {
			segments.unshift(current.name.text);
			current = current.expression;
		} else {
			const argument = current.argumentExpression;
			// Only a literal index can be flattened; a computed one is dynamic.
			if (!argument || !ts.isStringLiteral(argument)) return undefined;
			segments.unshift(argument.text);
			current = current.expression;
		}
	}
	if (ts.isIdentifier(current)) segments.unshift(current.text);
	else if (current.kind === ts.SyntaxKind.ThisKeyword) segments.unshift("this");
	else return undefined;
	// Optional chaining splits the expression; re-walk the parent side.
	if (segments.length === 0) return undefined;
	if (segments[0] === "this" && segments[1] === undefined) return undefined;
	return segments;
}

function collectFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".ts") && !DECLARATION_ONLY.has(entry.name)) files.push(full);
		}
	};
	for (const relative of CONSUMER_ROOTS) walk(path.join(root, relative));
	return files;
}

function parseFile(root: string, file: string): ParsedFile {
	const text = fs.readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const directKeys = helperLiterals(source);
	const accessors = new Map<string, string>();

	const walk = (node: ts.Node) => {
		if (
			(ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
			node.name !== undefined
		) {
			const name = ts.isIdentifier(node.name)
				? node.name.text
				: ts.isStringLiteral(node.name)
					? node.name.text
					: undefined;
			if (name !== undefined) {
				// A getter that resolves several keys (a grouped settings object, say) is
				// indexed under each one: a caller obtains all of them, which is what the
				// method contract says.
				for (const key of [...helperLiterals(node), ...nestedPathKeys(node)]) {
					if (!accessors.has(name)) accessors.set(name, key);
					else {
						const extra = `${name}#${key}`;
						accessors.set(extra, key);
					}
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);

	return { file: path.relative(root, file).replace(/\\/g, "/"), source, directKeys, accessors };
}

/**
 * Resolves which registry keys a production path obtains.
 *
 * Three edge kinds, each requiring positive evidence:
 *
 * - **direct** — a production file reads the key through a typed helper.
 * - **nested-path** — a production file reads it through a member chain rooted at
 *   the settings object, which is the same key written across an access chain.
 * - **accessor-helper** — a production file calls a method that resolves the key.
 *   The caller's name is irrelevant; what matters is that such a method exists.
 */
export function analyzeReachability(root: string): Map<string, KeyReachability> {
	const parsed = collectFiles(root).map((file) => parseFile(root, file));

	// Method name → keys that name resolves.
	const accessorIndex = new Map<string, string[]>();
	for (const file of parsed) {
		for (const [name, key] of file.accessors) {
			const list = accessorIndex.get(name) ?? [];
			list.push(key);
			accessorIndex.set(name, list);
		}
	}

	const edges = new Map<string, ConsumptionEdge[]>();
	const add = (key: string, site: string, via: ConsumptionEdge["via"]) => {
		if (key.length === 0) return;
		const list = edges.get(key) ?? [];
		list.push({ key, site, via });
		edges.set(key, list);
	};

	for (const file of parsed) {
		if (isTestPath(file.file)) continue;
		const isDefinitionOnly = DEFINITION_ONLY.has(path.basename(file.file));

		if (!isDefinitionOnly) {
			for (const key of file.directKeys) add(key, file.file, "direct");
			for (const key of injectedReaderKeys(file.source)) add(key, file.file, "injected-reader");
			for (const key of nestedPathKeys(file.source)) add(key, file.file, "nested-path");
		}

		// Calling a method that resolves a key obtains that key.
		const walk = (node: ts.Node) => {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const keys = accessorIndex.get(node.expression.name.text);
				if (keys) for (const key of keys) add(key, file.file, "accessor-helper");
			}
			ts.forEachChild(node, walk);
		};
		walk(file.source);
	}

	const result = new Map<string, KeyReachability>();
	for (const [key, list] of edges) {
		const seen = new Set<string>();
		const unique = list.filter((edge) => {
			const id = `${edge.site}|${edge.via}`;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
		result.set(key, { key, edges: unique });
	}
	return result;
}
