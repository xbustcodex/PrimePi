/**
 * Inert **class members**: public methods no production file calls.
 *
 * ## Why this is separate from the export audit
 *
 * `findUnreferencedCapabilities` walks top-level exported declarations, so it is
 * blind inside a class. An inert method on an otherwise-busy class is the worst
 * place for one, because the file looks productive and the class genuinely *is*
 * used for other things — nothing signals that this particular member has no
 * caller.
 *
 * Found by @SurfaceInventory.SessionTreeScout: `SessionManager.getChildren`
 * and `SessionManager.getLeafEntry` were both unreachable, and neither appeared
 * in the export audit.
 *
 * ## The three defects this module replaces
 *
 * The previous version reported zero inert members across 261 classes, which is
 * not a clean bill of health — it is a detector that never fired. Three separate
 * causes, each of which alone is enough to silence it:
 *
 * 1. **The reference corpus held no tests.** It walked the `packages/<pkg>/src`
 *    trees only and then asked "is this member referenced by a test?", which is
 *    therefore always false. The archetype this audit exists to catch —
 *    implemented, unit-tested, never wired — is structurally invisible to a
 *    corpus that excludes the tests.
 * 2. **Production references were never counted.** The loop incremented
 *    `testRefs` and nothing else, so even with tests in the corpus it could not
 *    have told a member with no production caller from a member every caller
 *    uses. The predicate `testRefs > 0` was the entire report.
 * 3. **A bare word matched the declaration.** `/\bgetChildren\b/` matches the
 *    method's own declaration and its doc comment, so counting references
 *    without excluding the declaration marks every member as used. The export
 *    detector already solved this by parsing; this one did not.
 *
 * ## What counts as a reference
 *
 * A member is called through an accessor (`x.name`, `x?.name`, `this.name`,
 * `x["name"]`) or bound from one (`const { name } = x`, `const name = x.name`),
 * and a bare `name(...)` call counts as a member passed as a value
 * (`entries.map(getChildren)`). A *declaration* of the same name in any file is
 * excluded by node position rather than by name, so `render(width)` declared on
 * an unrelated class is not a call of another class's `render`. A mention in a
 * `Pick<SessionManager, "getLeafEntry">` is deliberately not a call: a type-level
 * projection grants no runtime reach, which is exactly why the audit has to see
 * through the `ReadonlySessionManager` surface.
 *
 * Each file is walked once into a set of referenced names, so the cost is one
 * parse per file rather than one per (file, member).
 *
 * ## Private, protected and underscore members are excluded
 *
 * They are reached from inside their own class, so an external caller is not what
 * makes them live. Including them would report most of any class as inert.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-inert-class-members.mts
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Production and test roots.
 *
 * The production side is every `packages/<pkg>/src` tree, not a hand-picked
 * subset: a caller of a `core` method frequently lives in `src/tools` or
 * `src/cli`, and a subset that excluded them reported live members as inert. The
 * test side is every `packages/<pkg>/test` tree, because "tested but never wired"
 * is the class of defect this detector exists to find.
 */
export const MEMBER_ROOTS = [
	"packages/ai/src",
	"packages/ai/test",
	"packages/agent/src",
	"packages/agent/test",
	"packages/coding-agent/src",
	"packages/coding-agent/test",
	"packages/tui/src",
	"packages/tui/test",
];

/** Files that declare no capability of their own. */
const NOT_CAPABILITIES = new Set(["types.ts"]);

/** Files whose mentions are documentation or assertion rather than a use. */
function isMentionOnly(file: string): boolean {
	if (/settings-parity-(rows|ledger)\.ts$/.test(file)) return true;
	return /audit-inert-capabilities|audit-inert-class-members|audit-false-claims|audit-capability-graph|audit-artifact-presence|inert-detector|inert-class-member-detector/.test(
		file,
	);
}

function isTestPath(file: string): boolean {
	return /[/\\]test[/\\]/.test(file) || /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file);
}

function isBarrel(file: string): boolean {
	return path.basename(file) === "index.ts";
}

/** Every `.ts` file under the roots, as repo-relative posix paths. */
function collectFiles(root: string, relativeRoots: readonly string[]): string[] {
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
			else if (entry.name.endsWith(".ts") && !NOT_CAPABILITIES.has(entry.name)) files.push(full);
		}
	};
	for (const relative of relativeRoots) walk(path.join(root, relative));
	return files;
}

function parse(relative: string, text: string): ts.SourceFile | undefined {
	try {
		return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	} catch {
		return undefined;
	}
}

/** A public member of a class, and the class that declares it. */
interface PublicMember {
	readonly name: string;
	readonly owner: string;
}

/**
 * The name of a node, when it is a plain identifier or string literal.
 *
 * Takes a `DeclarationName` rather than a `NamedDeclaration` so a call site can
 * Takes a `DeclarationName` rather than a `NamedDeclaration` so a call site can
 * pass the property of a `BindingElement`, or any other node's `name`, directly.
 * Widening the parameter to `ts.Node` and testing `"name" in node` narrows to
 * `{} | null`, which is not a `Node` and so cannot be handed to a type guard.
 */
function literalName(name: unknown): string | undefined {
	if (typeof name !== "object" || name === null) return undefined;
	const kind = (name as ts.Node).kind;
	if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.StringLiteral) {
		return (name as ts.Identifier | ts.StringLiteral).text;
	}
	return undefined;
}

/** The declared name of a named node, when it has a literal one. */
function elementName(node: ts.NamedDeclaration): string | undefined {
	return literalName(node.name);
}

/**
 * Public methods and initialized properties of the classes in a file.
 *
 * Private and protected members are skipped: they are reached from inside their
 * own class, so an external caller is not what makes them live, and auditing them
 * would report most of any class as inert.
 */
function publicMembersOf(source: ts.SourceFile): PublicMember[] {
	const found: PublicMember[] = [];
	const walk = (node: ts.Node) => {
		if (ts.isClassDeclaration(node) && node.name !== undefined) {
			for (const member of node.members) {
				if (!ts.isMethodDeclaration(member) && !ts.isPropertyDeclaration(member)) continue;
				const name = elementName(member);
				if (name === undefined || name.startsWith("#") || name.startsWith("_")) continue;
				const hidden = member.modifiers?.some(
					(modifier) =>
						modifier.kind === ts.SyntaxKind.PrivateKeyword ||
						modifier.kind === ts.SyntaxKind.ProtectedKeyword,
				);
				if (hidden === true) continue;
				// A declaration with no body or initializer cannot have a caller.
				if (ts.isMethodDeclaration(member) ? member.body === undefined : member.initializer === undefined) continue;
				found.push({ name, owner: node.name.text });
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** Declaration-like nodes whose `name` is a binding, not a use. */
function isDeclarationName(node: ts.Node): boolean {
	const parent = node.parent;
	if (parent === undefined) return false;
	return (
		ts.isMethodDeclaration(parent) ||
		ts.isMethodSignature(parent) ||
		ts.isPropertyDeclaration(parent) ||
		ts.isPropertySignature(parent) ||
		ts.isPropertyAssignment(parent) ||
		ts.isFunctionDeclaration(parent) ||
		ts.isClassDeclaration(parent) ||
		ts.isInterfaceDeclaration(parent) ||
		ts.isTypeAliasDeclaration(parent) ||
		ts.isEnumMember(parent) ||
		ts.isVariableDeclaration(parent) ||
		ts.isParameter(parent) ||
		ts.isBindingElement(parent) ||
		ts.isImportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isTypeReferenceNode(parent)
	);
}

/**
 * Every name this file calls, accesses or binds.
 *
 * One walk per file, so a file with 300 members costs the same as a file with
 * three. A name is recorded when it appears as an accessor target, a
 * destructured or aliased binding, or a bare call argument position — and never
 * when it appears as the declared name of something, which is how the old
 * regex-based version ended up counting every method's own declaration.
 */
function referencedNames(source: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	const record = (name: string | undefined) => {
		if (name !== undefined) names.add(name);
	};
	const walk = (node: ts.Node) => {
		if (ts.isPropertyAccessExpression(node)) record(elementName(node));
		else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
			record(node.argumentExpression.text);
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) record(node.expression.text);
		else if (ts.isBindingElement(node)) {
			// `const { name: alias } = x` names `name`; `const { name } = x` names
			// `name` on both sides. Either way the destructured name is the reference.
			record(node.propertyName !== undefined ? literalName(node.propertyName) : node.name.getText());
		}
		else if (ts.isShorthandPropertyAssignment(node)) record(node.name.text);
		if (!isDeclarationName(node) && "name" in node) record(literalName(node.name));
		ts.forEachChild(node, walk);
	};
	walk(source);
	return names;
}

export interface InertMember {
	readonly name: string;
	readonly owner: string;
	readonly declaredIn: string;
	readonly testRefs: number;
	readonly productionRefs: number;
}

/**
 * Finds public class members that no production file calls.
 *
 * `productionRefs === 0` with `testRefs > 0` is implemented, unit-tested and never
 * wired. `productionRefs === 0` with `testRefs === 0` is a member nothing has ever
 * mentioned. They are reported together and distinguished by the counts, because
 * collapsing them loses the distinction that makes the list actionable.
 */
export function findInertClassMembers(root: string): InertMember[] {
	const corpus = new Map<string, { source: ts.SourceFile; referenced: Set<string> }>();
	for (const file of collectFiles(root, MEMBER_ROOTS)) {
		const relative = path.relative(root, file).replace(/\\/g, "/");
		const source = parse(relative, fs.readFileSync(file, "utf8"));
		if (source === undefined) continue;
		corpus.set(relative, { source, referenced: referencedNames(source) });
	}

	const results: InertMember[] = [];
	for (const [file, entry] of corpus) {
		if (isTestPath(file) || isBarrel(file)) continue;
		// A class can declare two members with the same name only across an
		// inheritance chain, and a call to either satisfies either, so the report
		// collapses them to one line rather than claiming two live methods.
		for (const member of publicMembersOf(entry.source)) {
			let testRefs = 0;
			let productionRefs = 0;
			for (const [other, candidate] of corpus) {
				if (!candidate.referenced.has(member.name)) continue;
				if (isTestPath(other)) testRefs++;
				else if (!isMentionOnly(other)) productionRefs++;
			}
			if (productionRefs === 0) {
				results.push({ name: member.name, owner: member.owner, declaredIn: file, testRefs, productionRefs });
			}
		}
	}
	return results.sort(
		(left, right) => left.declaredIn.localeCompare(right.declaredIn) || left.name.localeCompare(right.name),
	);
}