/**
 * The production capability graph.
 *
 * ## What the existing audits answer, and what they miss
 *
 * `audit-inert-capabilities` answers "which exported symbols does no production
 * file mention". `audit-false-claims` answers "which ledger rows marked `wired`
 * have no proven read". `audit-inert-class-members` answers the same for public
 * methods. All three are *reachability* questions, and all three share one blind
 * spot: they stop at the import.
 *
 * An import is not a behaviour. Three distinct things hide behind "something
 * imports it":
 *
 * - **reachable** — a resolved chain of imports and calls connects the symbol to
 *   a production root, so it exists in the loaded module graph.
 * - **import-only** — the symbol's module is loaded but no resolved call anywhere
 *   in the reachable graph invokes it. `import { x } from "./y"` with `x` never
 *   called is reachable and inert at the same time.
 * - **behaviorally influential** — a resolved call site exists *and* the result
 *   flows somewhere observable: a return, an argument, an assignment, or a chain.
 *
 * The third class is the one no audit here detects, and it is worse than "never
 * called": a capability that is called and whose result is thrown away reports
 * itself wired to every reader of the source. The canonical shape is
 *
 *     resolveContextGauge(mode, usage);   // computed, result discarded
 *
 * ## Every edge is resolved, never guessed
 *
 * A call edge names a file. It is recorded only when the callee identifier
 * resolves, in that file, to either a top-level declaration of that file or a
 * named import of a specific module. `foo()` in a file that neither declares nor
 * imports `foo` produces no edge — keying call sites by bare name would silently
 * attribute every `render()` in the repo to every other `render`, which is the
 * same class of bug that made the class-member audit report zero.
 *
 * `this.member()` resolves to the member of the enclosing class in the same file,
 * which is what lets a settings-gated renderer be traced from a component to the
 * key it read.
 *
 * Where the final edge cannot be settled statically — the result of an observed
 * call returning to an unanalysable caller, or a key read in a file that never
 * reaches output — the node is marked `needs-behavioral-evidence` rather than
 * promoted. A graph that guesses is worse than no graph, because a wrong edge
 * reads exactly like a right one.
 *
 * ## What is deliberately not in the graph
 *
 * - **Test files are never production.** A caller under `test/` is recorded as
 *   `testRefs` and contributes no production edge.
 * - **Declaration sites are not consumers.** `settings-descriptors.ts` declares a
 *   key; a read of that key elsewhere is the edge.
 * - **A claim file is not evidence.** `settings-parity-rows.ts` records what a row
 *   says its consumer is. Counting it would let the ledger vouch for itself, which
 *   is the defect `audit-false-claims` exists to catch.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-capability-graph.mts
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Workspace package name to its source root.
 *
 * The bundle resolves these through `package.json` exports; the graph resolves
 * them to source so an edge names the file a reviewer can open.
 */
const WORKSPACE: Record<string, string> = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-tui": "packages/tui/src",
	"@earendil-works/pi-protocol": "packages/protocol/src",
};

/**
 * Production roots.
 *
 * `cli.ts` is what `dist/bundle/cli.js` is built from and is the only file a user
 * launches; `rpc-entry.ts` is the second published bin; `index.ts` is the declared
 * `main`, so a library consumer reaches it too. A test file is never a root: a
 * capability reachable only from a test is inert at runtime, which is the entire
 * point of the graph.
 */
export const ROOTS = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/rpc-entry.ts",
	"packages/coding-agent/src/index.ts",
];

/** Path prefixes that decide a module's layer. First match wins. */
const LAYER_BY_PREFIX: readonly (readonly [string, CapabilityLayer])[] = [
	["packages/coding-agent/src/cli.ts", "root"],
	["packages/coding-agent/src/rpc-entry.ts", "root"],
	["packages/coding-agent/src/modes/interactive/interactive-mode.ts", "lifecycle"],
	["packages/coding-agent/src/core/agent-session.ts", "lifecycle"],
	["packages/coding-agent/src/core/settings-manager.ts", "policy"],
	["packages/coding-agent/src/core/settings-registry.ts", "policy"],
	["packages/coding-agent/src/core/settings-descriptors.ts", "policy"],
	["packages/coding-agent/src/modes/", "lifecycle"],
	["packages/coding-agent/src/core/", "service"],
	["packages/tui/src/", "service"],
	["packages/agent/src/", "service"],
	["packages/ai/src/", "service"],
	["packages/coding-agent/src/", "capability"],
];

export type CapabilityLayer = "root" | "lifecycle" | "service" | "capability" | "policy" | "effect";

/** How strong the evidence for a classification is. */
export type Evidence = "proven" | "needs-behavioral-evidence";

/** The three-way classification, plus the case where nothing reaches the symbol. */
export type Classification = "reachable" | "import-only" | "behaviorally-inert" | "unreachable";

export type EdgeKind = "import" | "call" | "observed" | "discarded" | "key-read";

export interface CapabilityEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: EdgeKind;
}

export interface CapabilityNode {
	/** `symbol`, `member`, or `setting`. */
	readonly kind: "symbol" | "member" | "setting";
	readonly name: string;
	/** `Owner.member` for a class member, otherwise the plain symbol name. */
	readonly label: string;
	readonly declaredIn: string;
	readonly layer: CapabilityLayer;
	readonly classification: Classification;
	readonly evidence: Evidence;
	/** Production files whose resolved call site reaches this node. */
	readonly productionRefs: readonly string[];
	/** Test files that reach this node. */
	readonly testRefs: readonly string[];
}

export interface CapabilityGraph {
	readonly nodes: readonly CapabilityNode[];
	readonly edges: readonly CapabilityEdge[];
	/** Module paths in the transitive value-import closure of a root. */
	readonly reachableModules: ReadonlySet<string>;
}

/** Where a symbol sits in the six-layer trace. */
const LAYER_ORDER: readonly CapabilityLayer[] = ["root", "lifecycle", "service", "capability", "policy", "effect"];

/** Files whose mentions are documentation or assertion rather than a use. */
function isMentionOnly(file: string): boolean {
	if (/settings-parity-(rows|ledger)\.ts$/.test(file)) return true;
	if (/verification-debt|migration-completion-rule/.test(file)) return true;
	return /audit-|inert-detector|reconcile-evidence|ledger-progression/.test(file);
}

function isTestPath(file: string): boolean {
	return /[/\\]test[/\\]/.test(file) || /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file);
}

/** Whether a file declares capabilities rather than consuming them. */
function isDeclarationFile(file: string): boolean {
	return /settings-descriptors\.ts$|settings-registry\.ts$/.test(file);
}

function layerOf(file: string): CapabilityLayer {
	for (const [prefix, layer] of LAYER_BY_PREFIX) if (file === prefix || file.startsWith(`${prefix}/`)) return layer;
	return "capability";
}

function existsFile(absolute: string): boolean {
	try {
		return fs.statSync(absolute).isFile();
	} catch {
		return false;
	}
}

function resolveSpec(spec: string, fromFile: string, root: string): string | undefined {
	if (spec.startsWith("node:")) return undefined;
	const asRepo = (absolute: string): string | undefined => {
		const relative = path.relative(root, absolute).replace(/\\/g, "/");
		return existsFile(path.join(root, relative)) ? relative : undefined;
	};
	if (spec.startsWith(".")) {
		// Anchored to `root`, not to the process working directory. `fromFile` is a
		// repo-relative path, so `path.resolve` would resolve it against whatever
		// directory the caller happened to run from. The CLI runs from the repo root
		// and a test runs from a package, so the same code produced a correct graph in
		// one and a silently edge-less one in the other — the graph looking right in a
		// terminal and wrong where it is actually asserted.
		const base = path.resolve(root, path.dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsFile(candidate)) return asRepo(candidate);
		}
		return undefined;
	}
	for (const [name, source] of Object.entries(WORKSPACE)) {
		if (spec !== name && !spec.startsWith(`${name}/`)) continue;
		const tail = spec === name ? "index" : spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const absolute = path.join(root, source, candidate);
			if (existsFile(absolute)) return asRepo(absolute);
		}
	}
	return undefined;
}

/** A module's top-level surface, plus what it imports. */
interface ModuleFacts {
	readonly file: string;
	readonly source: ts.SourceFile;
	readonly imports: readonly string[];
	/** Local identifier -> the module it names, for named value imports. */
	readonly importedNames: ReadonlyMap<string, string>;
	/** Exported top-level names. */
	readonly exports: ReadonlySet<string>;
	/** Class name -> its public member names. */
	readonly classMembers: ReadonlyMap<string, ReadonlySet<string>>;
	/** Declaration label -> whether its body can hand a value back. */
	readonly returnsValue: ReadonlyMap<string, boolean>;

	/**
	 * A named re-export, as `name -> module#originalName`. A barrel re-exports most
	 * of its surface this way, so resolving an import to the module that *names* it
	 * is not the same as resolving it to the module that *declares* it.
	 */
	readonly reexports: ReadonlyMap<string, string>;
	/**
	 * Modules re-exported wholesale by `export *`, in declaration order.
	 *
	 * A list, not a single entry: a package barrel commonly carries a dozen of them,
	 * and keeping only the last left every symbol outside that one module
	 * unresolvable — which is most of a package's surface.
	 */
	readonly starReexports: readonly string[];
}

/**
 * Module paths a module imports, its local binding names, and its re-exports.
 *
 * The re-export map is what makes the graph honest across a package barrel.
 * `checkEditFreshness` is declared in `packages/ai/src/utils/edit-guards.ts` and
 * reaches `core/tools/edit.ts` through `export *` in `packages/ai/src/index.ts`.
 * Without following that, every barrel-mediated symbol is attributed to the
 * barrel and reported as having no caller, which is the same class of bug the
 * class-member audit had: a detector whose misses are its own blind spot.
 */
function parseImports(file: string, source: ts.SourceFile, root: string): Pick<ModuleFacts, "imports" | "importedNames" | "reexports" | "starReexports"> {
	const imports = new Set<string>();
	const importedNames = new Map<string, string>();
	const reexports = new Map<string, string>();
	// A barrel commonly carries a dozen `export *` lines, so the targets are a
	// list. Keeping only the last one made every symbol except the final module's
	// unresolvable, which is the majority of a package's surface.
	const starReexports: string[] = [];
	const target = (specifier: ts.Expression): string | undefined => {
		if (!ts.isStringLiteralLike(specifier)) return undefined;
		const resolved = resolveSpec(specifier.text, file, root);
		if (resolved !== undefined) imports.add(resolved);
		return resolved;
	};
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			if (statement.importClause?.isTypeOnly === true) continue;
			const resolved = target(statement.moduleSpecifier);
			if (resolved === undefined) continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
			for (const element of bindings.elements) {
				if (!element.isTypeOnly) importedNames.set(element.name.text, resolved);
			}
			continue;
		}
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
			const resolved = target(statement.moduleSpecifier);
			if (resolved === undefined) continue;
			// `export { a, b as c } from "./x"` names its exports; `export * from "./x"`
			// does not, so the star targets are searched when a name does not resolve.
			if (statement.exportClause === undefined) {
				starReexports.push(resolved);
				continue;
			}
			if (!ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.isTypeOnly) continue;
				const original = element.propertyName?.text ?? element.name.text;
				reexports.set(element.name.text, `${resolved}#${original}`);
			}
		}
	}
	return { imports: [...imports], importedNames, reexports, starReexports };
}

/** Exported top-level declaration names, plus public members per class. */
function declarationsOf(source: ts.SourceFile): Pick<ModuleFacts, "exports" | "classMembers" | "returnsValue"> {
	const exports = new Set<string>();
	const classMembers = new Map<string, Set<string>>();
	const returnsValue = new Map<string, boolean>();
	const addExported = (name: ts.Node | undefined) => {
		if (name !== undefined && ts.isIdentifier(name)) exports.add(name.text);
	};
	for (const statement of source.statements) {
		if (
			!ts.isFunctionDeclaration(statement) &&
			!ts.isClassDeclaration(statement) &&
			!ts.isVariableStatement(statement)
		) {
			continue;
		}
		const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
		if (!exported) continue;
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) addExported(statement.name);
		else {
			for (const declaration of statement.declarationList.declarations) addExported(declaration.name);
		}
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
			returnsValue.set(statement.name.text, producesValue(statement));
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) continue;
				if (declaration.initializer !== undefined && ts.isArrowFunction(declaration.initializer)) {
					returnsValue.set(declaration.name.text, producesValue(declaration.initializer));
				} else if (declaration.initializer !== undefined && ts.isFunctionExpression(declaration.initializer)) {
					returnsValue.set(declaration.name.text, producesValue(declaration.initializer));
				}
			}
		}
	}
	const walk = (node: ts.Node) => {
		if (ts.isClassDeclaration(node) && node.name !== undefined) {
			const members = new Set<string>();
			for (const member of node.members) {
				if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
				const hidden = member.modifiers?.some(
					(modifier) =>
						modifier.kind === ts.SyntaxKind.PrivateKeyword ||
						modifier.kind === ts.SyntaxKind.ProtectedKeyword,
				);
				if (hidden === true) continue;
				if (!ts.isIdentifier(member.name)) continue;
				members.add(member.name.text);
				returnsValue.set(`${node.name.text}.${member.name.text}`, producesValue(member));
			}
			classMembers.set(node.name.text, members);
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return { exports, classMembers, returnsValue };
}

/**
 * Whether a function body can hand a value back.
 *
 * This decides whether discarding a call result is a defect or the intended
 * shape. `flushRawStdout()` written as a bare statement is how a void function is
 * supposed to be called; `resolveContextGauge(mode, usage)` written the same way
 * threw away a gauge the caller then had to recompute. Without this distinction
 * the behavioral-inert class fills with every void call in the repository, which
 * is the "detector reports noise" failure mode the class-member audit already
 * demonstrated once.
 *
 * A declared return type wins over the body: an explicit `void`, `undefined`, or
 * `Promise<void>` says the author discarded the value on purpose. Otherwise a
 * `return <expression>` anywhere in the body is enough, because a function that
 * has one is capable of handing a value back on some path.
 */
function producesValue(fn: ts.SignatureDeclarationBase & { body?: ts.Node }): boolean {
	const annotation = fn.type?.getText() ?? "";
	if (/(^|[<|])\s*void\s*($|[>|])/.test(annotation) || annotation.trim() === "undefined") return false;
	let produces = false;
	const walk = (node: ts.Node) => {
		if (produces) return;
		if (ts.isReturnStatement(node) && node.expression !== undefined) produces = true;
		// A nested function's `return` belongs to that function, not this one.
		else if (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node)
		) {
			if (node !== fn) return;
		}
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(fn, walk);
	return produces;
}

/**
 * Whether a call's value reaches an observer.
 *
 * This is the whole behavioral-inert question, and it is decidable without
 * whole-program dataflow: a call that *is* an expression statement threw its
 * result away, whatever it computed. The same call returned, assigned, passed, or
 * chained has its result observed.
 */
type Consumption = "discarded" | "observed" | "unknown";

function consumptionOf(call: ts.CallExpression): Consumption {
	const parent = call.parent;
	if (parent === undefined) return "unknown";
	if (ts.isExpressionStatement(parent)) return "discarded";
	if (ts.isAwaitExpression(parent) && parent.parent !== undefined && ts.isExpressionStatement(parent.parent)) {
		return "discarded";
	}
	if (
		ts.isVariableDeclaration(parent) ||
		ts.isPropertyAssignment(parent) ||
		ts.isReturnStatement(parent) ||
		ts.isParenthesizedExpression(parent) ||
		ts.isBinaryExpression(parent) ||
		ts.isConditionalExpression(parent) ||
		ts.isTemplateExpression(parent) ||
		ts.isArrayLiteralExpression(parent) ||
		ts.isCallExpression(parent) ||
		ts.isSpreadElement(parent)
	) {
		return "observed";
	}
	// An argument position, a property access chain, or an arrow body the analysis
	// does not descend into: genuinely unknown, not either of the above.
	return "unknown";
}

/** Typed settings readers whose first argument is the key. */
const KEY_HELPERS = new Set(["getSetting", "getString", "getNumber", "getBoolean", "getStringList"]);

export interface GraphOptions {
	/** Settings keys to include even with no proven read, so their state is reportable. */
	readonly settingsOfInterest?: readonly string[];
}

/**
 * Builds the graph.
 *
 * Roots are followed through resolved value imports only, so the reachable module
 * set is exactly the module graph Node evaluates. Then every module — production
 * and test — is walked once for resolved call sites, and each call is attributed
 * to the declaration it actually names.
 */
export function buildCapabilityGraph(root: string, options: GraphOptions = {}): CapabilityGraph {
	const modules = new Map<string, ModuleFacts>();
	const read = (file: string): ModuleFacts | undefined => {
		const cached = modules.get(file);
		if (cached !== undefined) return cached;
		const absolute = path.join(root, file);
		if (!existsFile(absolute)) return undefined;
		let source: ts.SourceFile;
		try {
			source = ts.createSourceFile(file, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		} catch {
			return undefined;
		}
		const facts: ModuleFacts = { file, source, ...parseImports(file, source, root), ...declarationsOf(source) };
		modules.set(file, facts);
		return facts;
	};

	const reachableModules = new Set<string>();
	const edges: CapabilityEdge[] = [];
	const queue = [...ROOTS];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (reachableModules.has(file)) continue;
		const module = read(file);
		if (module === undefined) continue;
		reachableModules.add(file);
		for (const imported of module.imports) {
			edges.push({ from: file, to: imported, kind: "import" });
			queue.push(imported);
		}
	}

	interface Site {
		readonly callers: Set<string>;
		readonly tests: Set<string>;
		readonly observed: Set<string>;
		readonly discarded: Set<string>;
		/** Call sites whose result the analysis cannot place: an argument, a chain. */
		readonly undecidable: Set<string>;
	}
	const sites = new Map<string, Site>();
	const record = (id: string, caller: string, consumption: Consumption) => {
		const existing = sites.get(id);
		const site =
			existing ??
			{ callers: new Set<string>(), tests: new Set<string>(), observed: new Set<string>(), discarded: new Set<string>(), undecidable: new Set<string>() };
		sites.set(id, site);
		site.callers.add(caller);
		if (isTestPath(caller)) {
			site.tests.add(caller);
			return;
		}
		// Discarding a result only counts when the callee could have produced one.
		// `flushRawStdout()` as a bare statement is how a void function is meant to
		// be called; counting it would fill the behaviorally-inert class with every
		// void call in the repo and make the class unreadable.
		const declaredIn = id.slice(0, id.indexOf("#"));
		const label = id.slice(id.indexOf("#") + 1);
		const produces = modules.get(declaredIn)?.returnsValue.get(label) === true;
		if (consumption === "discarded" && produces) site.discarded.add(caller);
		else if (consumption === "unknown") site.undecidable.add(caller);
		else site.observed.add(caller);
	};

	const keySites = new Map<string, { readers: Set<string>; tests: Set<string> }>();
	const noteKey = (key: string, reader: string) => {
		const entry = keySites.get(key) ?? { readers: new Set<string>(), tests: new Set<string>() };
		entry.readers.add(reader);
		if (isTestPath(reader)) entry.tests.add(reader);
		keySites.set(key, entry);
	};

	// Facts first, so a call site can ask its callee's file whether the body can
	// hand a value back, regardless of which file sorts first.
	const files = allSources(root);
	for (const file of files) read(file);

	/**
	 * Follows a name through the barrel chain to the module that declares it.
	 *
	 * A package's `index.ts` re-exports most of its surface, so resolving an import
	 * to the module that *names* it is not the same as resolving it to the module
	 * that *declares* it. Getting this wrong reports every barrel-mediated symbol
	 * as having no caller, which is most of a cross-package capability.
	 *
	 * Returns a module path, never a `module#name` id: the caller owns the id, and a
	 * helper that also appended a name produced `module#name#name`, which matched no
	 * node and silently dropped the edge. That is the shape of bug where the
	 * resolver looks correct in isolation and the graph is quietly wrong.
	 */
	const declaringModule = (name: string, via: string, depth = 0): string => {
		if (depth > 8) return via;
		const facts = modules.get(via);
		if (facts === undefined || facts.exports.has(name)) return via;
		const named = facts.reexports.get(name);
		if (named !== undefined) {
			const hash = named.indexOf("#");
			// `export { a as b } from "./x"`: the declaration is `a` in `x`, and the
			// name the barrel exposes is `b`. Both are needed to follow the hop.
			return hash === -1
				? declaringModule(name, named, depth + 1)
				: declaringModule(named.slice(hash + 1), named.slice(0, hash), depth + 1);
		}
		// Search every `export *` target, taking the first that actually declares the
		// name. Stopping at the first hop attributes the symbol to the barrel, which
		// is the miss this whole step exists to remove.
		for (const star of facts.starReexports) {
			if (modules.get(star)?.exports.has(name) === true) return star;
		}
		for (const star of facts.starReexports) {
			const resolved = declaringModule(name, star, depth + 1);
			if (resolved !== star) return resolved;
		}
		return via;
	};

	for (const file of files) {
		const module = read(file);
		if (module === undefined || isMentionOnly(file)) continue;
		// Resolve each call to the declaration it names. An unresolvable callee
		// produces no edge at all, which is the point: keying call sites by bare
		// name would attribute every `render()` in the repo to every other one.
		const resolveCallee = (name: string): string | undefined => {
			if (module.exports.has(name)) return `${file}#${name}`;
			// A `this.m()` call names a member of the enclosing class. `this` is only
			// known to one class, which the graph does not track, so a name matching
			// any class in the file resolves — and a name matching none resolves to
			// nothing.
			for (const [owner, members] of module.classMembers) {
				if (members.has(name)) return `${file}#${owner}.${name}`;
			}
			const imported = module.importedNames.get(name);
			return imported === undefined ? undefined : `${declaringModule(name, imported)}#${name}`;
		};

		const walk = (node: ts.Node) => {
			if (ts.isCallExpression(node)) {
				if (ts.isIdentifier(node.expression)) {
					const id = resolveCallee(node.expression.text);
					if (id !== undefined) record(id, file, consumptionOf(node));
				} else if (
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
				) {
					const id = resolveCallee(node.expression.name.text);
					if (id !== undefined) record(id, file, consumptionOf(node));
				}
				const [first] = node.arguments;
				if (
					ts.isPropertyAccessExpression(node.expression) &&
					KEY_HELPERS.has(node.expression.name.text) &&
					first !== undefined &&
					ts.isStringLiteralLike(first)
				) {
					noteKey(first.text, file);
				}
			}
			ts.forEachChild(node, walk);
		};
		walk(module.source);
	}

	const classify = (
		declaredIn: string,
		site: Site | undefined,
		inClosure: boolean,
	): { classification: Classification; evidence: Evidence } => {
		const callers = [...(site?.callers ?? [])].filter((caller) => !isTestPath(caller) && caller !== declaredIn);
		const observed = [...(site?.observed ?? [])];
		const discarded = [...(site?.discarded ?? [])];
		const undecidable = [...(site?.undecidable ?? [])];
		if (callers.length === 0) {
			return inClosure
				? { classification: "import-only", evidence: "proven" }
				: { classification: "unreachable", evidence: "proven" };
		}
		if (discarded.length > 0 && observed.length === 0) return { classification: "behaviorally-inert", evidence: "proven" };
		if (observed.length === 0 && undecidable.length > 0) {
			// Reached, and every call site passes the result onward somewhere this
			// analysis does not descend into. That is not proof of influence and not
			// proof of inertness; saying so is the whole point of the evidence field.
			return { classification: "reachable", evidence: "needs-behavioral-evidence" };
		}
		if (observed.length === 0) return { classification: "behaviorally-inert", evidence: "proven" };
		// Someone observed the result. Whether that observation reaches a terminal
		// effect is a whole-program dataflow question; a caller that also discards
		// the result is evidence the question is worth asking.
		return { classification: "reachable", evidence: discarded.length > 0 ? "proven" : "needs-behavioral-evidence" };
	};

	const nodes: CapabilityNode[] = [];
	for (const file of [...modules.keys()].sort()) {
		if (isTestPath(file)) continue;
		const module = modules.get(file) as ModuleFacts;
		const inClosure = reachableModules.has(file);
		const declarations: { label: string; kind: "symbol" | "member" }[] = [
			...[...module.exports].sort().map((name) => ({ label: name, kind: "symbol" as const })),
			...[...module.classMembers.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.flatMap(([owner, members]) =>
					[...members].sort().map((member) => ({ label: `${owner}.${member}`, kind: "member" as const })),
				),
		];
		for (const declaration of declarations) {
			const site = sites.get(`${file}#${declaration.label}`);
			const { classification, evidence } = classify(file, site, inClosure);
			const productionRefs = [...(site?.observed ?? []), ...(site?.discarded ?? [])]
				.filter((caller) => !isTestPath(caller) && caller !== file)
				.sort();
			nodes.push({
				kind: declaration.kind,
				name: declaration.label,
				label: declaration.label,
				declaredIn: file,
				layer: layerOf(file),
				classification,
				evidence,
				productionRefs,
				testRefs: [...(site?.tests ?? [])].sort(),
			});
			for (const caller of productionRefs) edges.push({ from: caller, to: `${file}#${declaration.label}`, kind: site?.observed.has(caller) === true ? "observed" : "discarded" });
		}
	}

	const descriptorFile = "packages/coding-agent/src/core/settings-descriptors.ts";
	const descriptorSource = existsFile(path.join(root, descriptorFile))
		? fs.readFileSync(path.join(root, descriptorFile), "utf8")
		: "";
	const keys = [...new Set([...(options.settingsOfInterest ?? []), ...[...keySites.keys()]])].sort();
	for (const key of keys) {
		const entry = keySites.get(key);
		const readers = [...(entry?.readers ?? [])].filter((reader) => !isTestPath(reader)).sort();
		const tests = [...(entry?.tests ?? [])].sort();
		const declares = descriptorSource.includes(`key: "${key}"`);
		nodes.push({
			kind: "setting",
			name: key,
			label: key,
			declaredIn: declares ? descriptorFile : "packages/coding-agent/src/core/settings-descriptors.ts",
			layer: "policy",
			classification:
				readers.length === 0 ? (tests.length > 0 ? "import-only" : "unreachable") : "reachable",
			// A key with no read is not wired however it is classified, and a key read
			// in a file that never renders anything needs a behavioural check.
			evidence: readers.length === 0 || readers.every((reader) => !isEffectSite(reader)) ? "needs-behavioral-evidence" : "proven",
			productionRefs: readers,
			testRefs: tests,
		});
		for (const reader of readers) edges.push({ from: reader, to: `setting:${key}`, kind: "key-read" });
	}

	return { nodes, edges, reachableModules };
}

/**
 * Whether a file is one where a read can become visible output.
 *
 * A render path, a CLI entry, or an HTTP response can; a settings declaration, a
 * ledger, or a test cannot. This is the difference between "someone read it" and
 * "someone shipped it".
 */
function isEffectSite(file: string): boolean {
	if (isTestPath(file) || isMentionOnly(file) || isDeclarationFile(file)) return false;
	return (
		/^packages\/coding-agent\/src\/(cli|rpc-entry|index)\.ts$/.test(file) ||
		/modes\/interactive\//.test(file) ||
		/packages\/tui\/src\/(tui|layout|components|terminal|overlays|scrollback|transcript)\//.test(file) ||
		/packages\/coding-agent\/src\/core\/export-html\//.test(file) ||
		/packages\/ai\/src\/(api|providers)\//.test(file) ||
		/packages\/coding-agent\/src\/modes\/rpc\//.test(file)
	);
}

/** Every source file under the packages the graph covers, production and test. */
function allSources(root: string): string[] {
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
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist") continue;
				walk(full);
			} else if (entry.name.endsWith(".ts") && entry.name !== "types.ts") {
				files.push(path.relative(root, full).replace(/\\/g, "/"));
			}
		}
	};
	for (const pkg of ["ai", "agent", "coding-agent", "tui"]) {
		walk(path.join(root, "packages", pkg, "src"));
		walk(path.join(root, "packages", pkg, "test"));
	}
	return files.sort();
}

/** The layer chain a trace prints, root first. */
export function traceLayers(from: string, to: string): readonly CapabilityLayer[] {
	const fromIndex = LAYER_ORDER.indexOf(layerOf(from));
	const toIndex = LAYER_ORDER.indexOf(layerOf(to));
	if (fromIndex < 0 || toIndex < 0) return [];
	return LAYER_ORDER.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1);
}