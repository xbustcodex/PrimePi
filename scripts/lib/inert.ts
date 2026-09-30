/**
 * Inert-capability detection for migration-era modules.
 *
 * ## Why this is separate from the settings audit
 *
 * A capability with no Settings row can be exactly as inert as one with. The
 * archetypes this program found were all *code* problems:
 *
 * - implemented but uncalled
 * - tested but no production caller
 * - a decision returned that nobody uses
 * - configuration computed and discarded
 * - a clamp whose result is ignored
 * - a default shadowing a configured value
 * - reachable only from tests
 * - state-independent presentation
 *
 * None of those are visible from a settings key. So this scans exported symbols
 * and reports the ones no production file imports.
 *
 * ## A barrel re-export is a reference
 *
 * This is the detail that decides whether the scan is useful at all. A package
 * index says `export * from "./advisor/emission-guard.ts"`, which imports every
 * symbol that module declares **without naming any of them**. Counting only
 * textual mentions makes every capability whose sole importer is the barrel look
 * unreferenced — the first version of this scan reported 754 unreachable symbols
 * including several wired earlier in this same program.
 *
 * ## It is a detector, not a verdict
 *
 * A symbol may also be reached through a framework callback or a name that
 * differs from its declaration. Every hit is a candidate for a human to settle.
 * The scan only ever under-reports, which is the safe direction for a list that
 * gets reviewed.
 */

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/** Directories whose exports are eligible to be checked. */
const MODULE_ROOTS = [
	"packages/ai/src",
	"packages/agent/src",
	"packages/coding-agent/src/core",
	"packages/coding-agent/src/modes",
	"packages/tui/src",
	// Test roots are scanned for references only. A capability whose sole importer is a
	// test is the archetype this program hit repeatedly, and it cannot be seen from a
	// production-only corpus.
	"packages/ai/test",
	"packages/agent/test",
	"packages/coding-agent/test",
	"packages/tui/test",
];

/** Files that declare no capability of their own. */
const NOT_CAPABILITIES = new Set(["types.ts"]);

/** Test paths: a symbol imported only from a test may be inert at runtime. */
function isTestPath(file: string): boolean {
	return /[/\\]test[/\\]/.test(file) || /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file);
}

/** Barrel files re-export rather than declare, but their text still references. */
function isBarrel(file: string): boolean {
	return path.basename(file) === "index.ts";
}

export interface UnreferencedSymbol {
	readonly name: string;
	/** File that declares it. */
	readonly declaredIn: string;
	/** Production files that reference or re-export it. */
	readonly productionRefs: number;
	/** Test files that reference it. */
	readonly testRefs: number;
	readonly kind: "function" | "class" | "const";
}

/** Every `.ts` file under a root, as repo-relative posix paths. */
function collectFiles(root: string, relativeRoots: string[]): string[] {
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
			else if (entry.name.endsWith(".ts")) files.push(path.relative(root, full).replace(/\\/g, "/"));
		}
	};
	for (const relative of relativeRoots) walk(path.join(root, relative));
	return files;
}

/** The directory portion of a repo-relative path, ending in a separator. */
function dirOf(file: string): string {
	return file.slice(0, file.lastIndexOf("/") + 1);
}

/** The module file a relative import specifier resolves to, or undefined. */
function specifierToFile(specifier: string, fromDir: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
	return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

/**
 * Whether a file re-exports `target` with a star.
 *
 * `export * from "./x.ts"` imports every symbol `x` declares without naming
 * them, so a textual mention search alone would call every barrel-only
 * capability unused.
 */
function starExports(source: string, target: string, fromDir: string): boolean {
	const star = /export\s+\*\s+from\s+"([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = star.exec(source)) !== null) {
		if (specifierToFile(match[1]!, fromDir) === target) return true;
	}
	return false;
}

/** Named exports of a module, with the kind of declaration. */
function exportsOf(file: string): { name: string; kind: UnreferencedSymbol["kind"] }[] {
	let source: ts.SourceFile;
	try {
		source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	} catch {
		return [];
	}
	const found: { name: string; kind: UnreferencedSymbol["kind"] }[] = [];
	const add = (name: string | undefined, kind: UnreferencedSymbol["kind"]) => {
		if (name !== undefined && name.length > 0 && !name.startsWith("_")) found.push({ name, kind });
	};
	const walk = (node: ts.Node) => {
		const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		if (exported) {
			if (ts.isFunctionDeclaration(node)) add(node.name?.text, "function");
			else if (ts.isClassDeclaration(node)) add(node.name?.text, "class");
			else if (ts.isVariableStatement(node)) {
				for (const declaration of node.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name)) add(declaration.name.text, "const");
				}
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/**
 * Character spans each export declaration occupies, keyed by name.
 *
 * A name can appear in its own doc comment and a signature can span lines, so
 * removing the declaration line by line is not reliable. The AST knows the exact
 * span, and using it is what keeps a documented-but-unused helper from looking
 * used by its own documentation.
 */
function spansOf(file: string): Map<string, [number, number]> {
	const spans = new Map<string, [number, number]>();
	let source: ts.SourceFile;
	try {
		source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	} catch {
		return spans;
	}
	const record = (node: ts.Node, name: string | undefined) => {
		if (name === undefined) return;
		spans.set(name, [node.getFullStart(), node.getEnd()]);
	};
	const walk = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name) record(node, node.name.text);
		else if (ts.isClassDeclaration(node) && node.name) record(node, node.name.text);
		else if (ts.isVariableStatement(node)) {
			for (const declaration of node.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) record(node, declaration.name.text);
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return spans;
}

/** A file with one declaration span removed, for same-file reference counting. */
function stripDeclarationSpans(text: string, span: [number, number]): string {
	return text.slice(0, span[0]) + text.slice(span[1]);
}

/**
 * Finds exported capabilities that no production file imports.
 *
 * Reported in two groups, because they mean different things: a symbol nothing
 * references may be dead, while one only tests reference is the archetype this
 * program hit repeatedly — a good implementation with no runtime path.
 */
export function findUnreferencedCapabilities(root: string): UnreferencedSymbol[] {
	const allFiles = collectFiles(root, MODULE_ROOTS);
	const corpus = new Map(allFiles.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")] as const));

	// Declaration spans per file, so a name inside its own declaration or its doc
	// comment is not counted as a use.
	const declarationSpans = new Map(allFiles.map((file) => [file, spansOf(path.join(root, file))] as const));
	const results: UnreferencedSymbol[] = [];
	for (const file of allFiles) {
		if (isTestPath(file) || NOT_CAPABILITIES.has(path.basename(file)) || isBarrel(file)) continue;
		for (const exported of exportsOf(file)) {
			let productionRefs = 0;
			let testRefs = 0;
			const pattern = new RegExp(`\\b${exported.name}\\b`);
			for (const [other, text] of corpus) {
				// A declaration is not a use. The declaring line is removed first, and what
				// remains is a real reference — including one in the same file, which is the
				// common case for a helper a tool file consumes itself.
				//
				// The earlier version built this pattern with doubled backslashes, so the
				// declaration was never stripped, every symbol matched itself, and the scan
				// reported zero unreferenced capabilities.
				// The declaring file is handled by span exclusion: a doc comment mentioning
				// the name, and a multi-line signature, both survive a line-level regex.
				const declarationSpan = other === file ? declarationSpans.get(other)?.get(exported.name) : undefined;
				const referenced =
					declarationSpan === undefined
						? pattern.test(text)
						: pattern.test(stripDeclarationSpans(text, declarationSpan)) ||
							(isBarrel(other) && starExports(text, file, dirOf(other)));
				if (!referenced) continue;
				if (isTestPath(other)) testRefs++;
				else productionRefs++;
			}
			if (productionRefs === 0) {
				results.push({ name: exported.name, declaredIn: file, productionRefs, testRefs, kind: exported.kind });
			}
		}
	}
	return results.sort(
		(left, right) => left.declaredIn.localeCompare(right.declaredIn) || left.name.localeCompare(right.name),
	);
}
