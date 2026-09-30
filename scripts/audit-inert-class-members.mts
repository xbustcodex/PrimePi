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
 * ## Private and protected members are excluded
 *
 * They are reached from inside their own class, so an external caller is not
 * what makes them live. Including them would report most of any class as inert.
 *
 * Run from the repo root:
 *
 *     npx tsx scripts/audit-inert-class-members.mts
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Directories whose classes are eligible. */
const MODULE_ROOTS = [
	"packages/ai/src",
	"packages/agent/src",
	"packages/coding-agent/src/core",
	"packages/coding-agent/src/modes",
	"packages/tui/src",
];

/** Files that declare no capability of their own. */
const NOT_CAPABILITIES = new Set(["types.ts"]);

/** Files whose mentions are documentation or assertion rather than a use. */
function isMentionOnly(file: string): boolean {
	if (/settings-parity-(rows|ledger)\.ts$/.test(file)) return true;
	return /audit-inert-capabilities|audit-false-claims|audit-artifact-presence|inert-detector/.test(file);
}

function isTestPath(file: string): boolean {
	return /[/\\]test[/\\]/.test(file) || /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file);
}

function isBarrel(file: string): boolean {
	return path.basename(file) === "index.ts";
}

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
			else if (entry.name.endsWith(".ts") && !NOT_CAPABILITIES.has(entry.name)) files.push(full);
		}
	};
	for (const relative of relativeRoots) walk(path.join(root, relative));
	return files;
}

/** Public methods of the classes in a file. */
function publicMethodsOf(source: ts.SourceFile): string[] {
	const found: string[] = [];
	const walk = (node: ts.Node) => {
		if (ts.isClassDeclaration(node)) {
			for (const member of node.members) {
				const isCandidate = ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member);
				if (!isCandidate || member.name === undefined) continue;
				const name = ts.isIdentifier(member.name)
					? member.name.text
					: ts.isStringLiteral(member.name)
						? member.name.text
						: undefined;
				if (name === undefined) continue;
				// Reached from inside their own class, so an external caller is not what
				// makes them live; auditing them would flag most of any class.
				if (name.startsWith("#") || name.startsWith("_")) continue;
				const modifiers = ("modifiers" in member ? member.modifiers : undefined) as ts.ModifierLike[] | undefined;
				const visibility = modifiers?.find(
					(modifier) =>
						modifier.kind === ts.SyntaxKind.PrivateKeyword ||
						modifier.kind === ts.SyntaxKind.ProtectedKeyword,
				);
				if (visibility !== undefined) continue;
				// A declaration without an implementation cannot have a caller.
				if (ts.isPropertyDeclaration(member) && member.initializer === undefined) continue;
				found.push(name);
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

export interface InertMember {
	readonly name: string;
	readonly declaredIn: string;
	readonly testRefs: number;
}

export function findInertClassMembers(root: string): InertMember[] {
	const allFiles = collectFiles(root, MODULE_ROOTS);
	const corpus = new Map(allFiles.map((file) => [file, fs.readFileSync(file, "utf8")] as const));

	const results: InertMember[] = [];
	for (const file of allFiles) {
		const relative = path.relative(root, file).replace(/\\/g, "/");
		if (isTestPath(relative) || isBarrel(relative)) continue;
		let source: ts.SourceFile;
		try {
			source = ts.createSourceFile(relative, corpus.get(file)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		} catch {
			continue;
		}
		for (const name of publicMethodsOf(source)) {
			const pattern = new RegExp(`\\b${name}\\b`);
			let testRefs = 0;
			for (const [other, text] of corpus) {
				const otherRelative = path.relative(root, other).replace(/\\/g, "/");
				if (otherRelative === relative) continue;
				if (!pattern.test(text)) continue;
				if (isTestPath(otherRelative)) testRefs++;
			}
			if (testRefs > 0) results.push({ name, declaredIn: relative, testRefs });
		}
	}
	return results.sort(
		(left, right) => left.declaredIn.localeCompare(right.declaredIn) || left.name.localeCompare(right.name),
	);
}

const __all = collectFiles(process.cwd(), MODULE_ROOTS);
console.log("DBG corpus:", __all.length);
let __classes=0; for (const f of __all) { try { const s=ts.createSourceFile(f, fs.readFileSync(f,"utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); const w=(n:ts.Node)=>{ if(ts.isClassDeclaration(n)) __classes++; ts.forEachChild(n,w); }; w(s);} catch{} }
console.log("DBG classes:", __classes);
const found = findInertClassMembers(process.cwd());
const withTests = found.filter((member) => member.testRefs > 0);
console.log(`public class members referenced by a test but by no production file: ${withTests.length}`);
console.log(`(of ${found.length} public members with no production reference at all)\n`);

const byFile = new Map<string, string[]>();
for (const member of withTests) {
	const list = byFile.get(member.declaredIn) ?? [];
	list.push(`${member.name}(${member.testRefs})`);
	byFile.set(member.declaredIn, list);
}
for (const [file, members] of [...byFile].sort((left, right) => right[1].length - left[1].length).slice(0, 25)) {
	console.log(`  ${String(members.length).padStart(3)}  ${file}`);
	console.log(`       ${members.join(" ")}`);
}
